import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Candidate, CollectionError } from "@404sl/pitwall-schema";
import { WORKSPACE_FILES, readWorkspace, workspaceFile } from "./autofix.js";
import { issueCreator, readIssues, type NewIssue } from "./beads.js";
import { readCandidates } from "./candidates.js";
import { collectionError, failureOf } from "./errors.js";
import { planningSession } from "./intake.js";
import { upstreamIssueOf } from "./upstream.js";

const run = promisify(execFile);

const MAX_OUTPUT = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const IMPORT_LABEL = "needs-decision";
export const IMPORT_TYPE = "task";
export const ACTOR_FIELD = "actor";
export const TRUSTED_FIELD = "trustedIssueAuthors";
export const UNVERIFIED =
  "Nothing here has been verified. What follows is the reporter's own words, quoted as reported: somebody's report, not a specification.";
export const PROMOTION_QUESTION = "Is this report work for this project?";

export interface ImportOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  lockRoot?: string;
  timeoutMs?: number;
  actor?: string;
  now?: Date;
}

export interface ImportSettings {
  actor: string | undefined;
  trusted: string[];
}

export interface Imported {
  candidate: Candidate;
  id: string;
}

export interface Unimported {
  candidate: Candidate;
  reason: string;
}

export interface ImportResult {
  root: string | undefined;
  assignee: string | undefined;
  trusted: string[];
  imported: Imported[];
  failed: Unimported[];
  errors: CollectionError[];
}

export interface ImportedIssue {
  candidate: Candidate;
  body: string;
  outside: boolean;
  assignee: string;
  filedAt: string | undefined;
  importedAt: string;
}

export function workspaceRootOf(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (workspaceFile(dir) !== undefined) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function importSettings(root: string): ImportSettings {
  const found = workspaceFile(root);
  if (found === undefined) {
    return { actor: undefined, trusted: [] };
  }
  const parsed = JSON.parse(readFileSync(found.path, "utf8")) as Record<string, unknown> | null;
  const trusted = parsed?.[TRUSTED_FIELD];
  return {
    actor: asText(parsed?.[ACTOR_FIELD]),
    trusted: Array.isArray(trusted) ? trusted.filter((login): login is string => typeof login === "string") : [],
  };
}

export function isOutside(author: string | undefined, trusted: readonly string[]): boolean {
  return author === undefined || !trusted.some((login) => login.toLowerCase() === author.toLowerCase());
}

export function viewArgs(candidate: Candidate): string[] {
  return ["issue", "view", candidate.ref, "--json", "body"];
}

function quoted(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return "> (the issue was filed with no body)";
  }
  return lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

export function reporterLine(author: string | undefined, outside: boolean): string {
  const who = author === undefined ? "an account GitHub no longer names" : `@${author}`;
  return outside
    ? `Reported by ${who}, an outside contributor: not one of this workspace's ${TRUSTED_FIELD}.`
    : `Reported by ${who}, one of this workspace's ${TRUSTED_FIELD}.`;
}

export function descriptionOf(issue: ImportedIssue): string {
  const head = [
    `Imported from ${issue.candidate.url ?? issue.candidate.ref}`,
    reporterLine(issue.candidate.author, issue.outside),
    ...(issue.filedAt === undefined ? [] : [`Filed ${issue.filedAt}.`]),
  ];
  const tail = [
    `Parked with ${IMPORT_LABEL} and assigned to ${issue.assignee}. It becomes work only when a person removes the label and moves the assignee; nothing here does that.`,
    PROMOTION_QUESTION,
  ];
  return [head.join("\n"), UNVERIFIED, quoted(issue.body), tail.join("\n")].join("\n\n");
}

export function metadataOf(issue: ImportedIssue): Record<string, unknown> {
  return {
    import: {
      source: "github",
      url: issue.candidate.url ?? issue.candidate.ref,
      author: issue.candidate.author,
      outside: issue.outside,
      filedAt: issue.filedAt,
      importedAt: issue.importedAt,
    },
  };
}

export function newIssueOf(issue: ImportedIssue, files: { bodyFile: string; metadataFile: string }, actor: string): NewIssue {
  return {
    title: issue.candidate.title,
    bodyFile: files.bodyFile,
    metadataFile: files.metadataFile,
    assignee: issue.assignee,
    labels: [IMPORT_LABEL],
    issueType: IMPORT_TYPE,
    externalRef: issue.candidate.ref,
    actor,
  };
}

async function bodyOf(
  candidate: Candidate,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  const args = viewArgs(candidate);
  const command = ["gh", ...args].join(" ");
  let stdout: string;
  try {
    ({ stdout } = await run("gh", args, { encoding: "utf8", env, maxBuffer: MAX_OUTPUT, timeout: timeoutMs }));
  } catch (cause) {
    throw new Error(`${command}: ${failureOf(cause, timeoutMs)}`);
  }
  const parsed = JSON.parse(stdout) as { body?: unknown } | null;
  return typeof parsed?.body === "string" ? parsed.body : "";
}

function numberOf(candidate: Candidate): number {
  return upstreamIssueOf(candidate.ref)?.number ?? Number.MAX_SAFE_INTEGER;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function noWorkspace(cwd: string): CollectionError {
  return collectionError(
    resolve(cwd),
    `no ${WORKSPACE_FILES.join(" or ")} in ${resolve(cwd)} or any directory above it, so there is no tracker to import into`,
  );
}

function noActor(root: string): CollectionError {
  const file = workspaceFile(root)?.path ?? join(root, WORKSPACE_FILES[0]);
  return collectionError(
    file,
    `declares no "${ACTOR_FIELD}", and every write to the tracker carries one, so nothing was imported. Add "${ACTOR_FIELD}": "<project>-devloop" to it, or pass --actor <name>.`,
  );
}

export async function importCandidates(options: ImportOptions = {}): Promise<ImportResult> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const result: ImportResult = { root: undefined, assignee: undefined, trusted: [], imported: [], failed: [], errors: [] };
  const root = workspaceRootOf(cwd);
  if (root === undefined) {
    result.errors.push(noWorkspace(cwd));
    return result;
  }
  result.root = root;
  let settings: ImportSettings;
  try {
    settings = importSettings(root);
  } catch (cause) {
    result.errors.push(collectionError(workspaceFile(root)?.path ?? root, cause));
    return result;
  }
  result.trusted = settings.trusted;
  const actor = options.actor ?? settings.actor;
  if (actor === undefined) {
    result.errors.push(noActor(root));
    return result;
  }
  const project = readWorkspace(root, { lockRoot: options.lockRoot, env });
  result.assignee = planningSession(project.id);
  result.errors.push(...project.errors);
  const tracker = await readIssues(root, { env, errors: project.errors, timeoutMs, lanes: project.lanes });
  result.errors.push(...tracker.errors);
  const found = await readCandidates(project, {
    env,
    timeoutMs,
    linked: tracker.errors.length === 0 ? tracker.linked : undefined,
  });
  result.errors.push(...found.errors);
  if (found.candidates.length === 0) {
    return result;
  }
  const create = issueCreator(root, { env, timeoutMs });
  const room = mkdtempSync(join(tmpdir(), "pitwall-import-"));
  try {
    const candidates = [...found.candidates].sort((a, b) => numberOf(a) - numberOf(b));
    for (const candidate of candidates) {
      try {
        const issue: ImportedIssue = {
          candidate,
          body: await bodyOf(candidate, env, timeoutMs),
          outside: isOutside(candidate.author, settings.trusted),
          assignee: result.assignee,
          filedAt: candidate.createdAt,
          importedAt: (options.now ?? new Date()).toISOString(),
        };
        const bodyFile = join(room, "description.txt");
        const metadataFile = join(room, "metadata.json");
        writeFileSync(bodyFile, descriptionOf(issue), "utf8");
        writeFileSync(metadataFile, JSON.stringify(metadataOf(issue)), "utf8");
        const id = await create(newIssueOf(issue, { bodyFile, metadataFile }, actor));
        result.imported.push({ candidate, id });
      } catch (cause) {
        result.failed.push({ candidate, reason: reasonOf(cause) });
      }
    }
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
  return result;
}

function shortRef(candidate: Candidate): string {
  const upstream = upstreamIssueOf(candidate.ref);
  return upstream === undefined ? candidate.ref : `${upstream.slug}#${String(upstream.number)}`;
}

function byline(candidate: Candidate, trusted: readonly string[]): string {
  const who = candidate.author === undefined ? "an unnamed account" : `@${candidate.author}`;
  return isOutside(candidate.author, trusted) ? `${who} (outside contributor)` : who;
}

export function renderImport(result: ImportResult): { out: string; err: string; code: number } {
  const out: string[] = [];
  const err: string[] = [];
  for (const error of result.errors) {
    err.push(`${error.source}: ${error.message}`);
  }
  const count = result.imported.length;
  if (count > 0) {
    out.push(
      `${String(count)} issue${count === 1 ? "" : "s"} imported, parked with ${IMPORT_LABEL} for ${result.assignee ?? "the planning session"}.`,
    );
    for (const entry of result.imported) {
      out.push(`  ${shortRef(entry.candidate)} -> ${entry.id}  ${byline(entry.candidate, result.trusted)}`);
    }
  } else if (result.errors.length === 0 && result.failed.length === 0) {
    out.push("0 issues imported: every open issue is already linked to a tracker item.");
  }
  for (const entry of result.failed) {
    err.push(`${shortRef(entry.candidate)} was not imported: ${entry.reason}`);
  }
  const code = result.errors.length > 0 || result.failed.length > 0 ? 1 : 0;
  return {
    out: out.length === 0 ? "" : `${out.join("\n")}\n`,
    err: err.map((line) => `pitwall import: ${line}\n`).join(""),
    code,
  };
}
