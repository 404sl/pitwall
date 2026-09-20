import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Candidate, type CollectionError, type Project, type Signal } from "@404sl/pitwall-schema";
import { collectionError, failureOf } from "./errors.js";
import { remoteSlugOf } from "./git.js";
import { upstreamIssueOf } from "./upstream.js";

const run = promisify(execFile);

const MAX_OUTPUT = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
export const LIST_LIMIT = 200;
const LIST_FIELDS = "number,title,url,author,createdAt";

export interface ReadCandidatesOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  linked?: readonly string[];
}

export interface CollectedCandidates {
  signals: Signal[];
  candidates: Candidate[];
  errors: CollectionError[];
}

export function listArgs(slug: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    slug,
    "--state",
    "open",
    "--limit",
    String(LIST_LIMIT),
    "--json",
    LIST_FIELDS,
  ];
}

function commandOf(args: readonly string[]): string {
  return ["gh", ...args].join(" ");
}

const GITHUB_SLUG = /^[^/]+\/[^/]+$/;

export function signalOf(slug: string): Signal {
  return { kind: "github", name: slug, location: `https://github.com/${slug}/issues` };
}

async function gh<T>(
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
  shape: (parsed: unknown) => T,
): Promise<T> {
  const command = commandOf(args);
  let stdout: string;
  try {
    ({ stdout } = await run("gh", args as string[], {
      encoding: "utf8",
      env,
      maxBuffer: MAX_OUTPUT,
      timeout: timeoutMs,
    }));
  } catch (cause) {
    throw new Error(`${command}: ${failureOf(cause, timeoutMs)}`);
  }
  try {
    return shape(JSON.parse(stdout));
  } catch (cause) {
    throw new Error(`${command}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function asRows(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) {
    throw new TypeError("output is not an array of issues");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`issue ${index} is not an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function loginOf(author: unknown): string | undefined {
  if (typeof author !== "object" || author === null) {
    return undefined;
  }
  return textOf((author as Record<string, unknown>)["login"]);
}

function linkKey(reference: string): string | undefined {
  const upstream = upstreamIssueOf(reference);
  return upstream === undefined ? undefined : `${upstream.slug.toLowerCase()}#${upstream.number}`;
}

export function linkedKeys(linked: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const reference of linked) {
    const key = linkKey(reference);
    if (key !== undefined) {
      keys.add(key);
    }
  }
  return keys;
}

async function issuesOf(
  name: string,
  slug: string,
  linked: ReadonlySet<string>,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Pick<CollectedCandidates, "candidates" | "errors">> {
  const listing = listArgs(slug);
  const errors: CollectionError[] = [];
  let rows: Record<string, unknown>[];
  try {
    rows = await gh(listing, env, timeoutMs, asRows);
  } catch (cause) {
    return { candidates: [], errors: [collectionError(commandOf(listing), cause)] };
  }
  if (rows.length >= LIST_LIMIT) {
    errors.push(
      collectionError(
        commandOf(listing),
        `listing came back at the ${LIST_LIMIT} issue limit; any open issue past it was not read`,
      ),
    );
  }
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const number = row["number"];
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      continue;
    }
    const ref = `https://github.com/${slug}/issues/${number}`;
    if (linked.has(`${slug.toLowerCase()}#${number}`)) {
      continue;
    }
    candidates.push(
      Candidate.parse({
        source: slug,
        ref,
        title: textOf(row["title"]) ?? `#${number}`,
        repo: name,
        url: textOf(row["url"]) ?? ref,
        author: loginOf(row["author"]),
        createdAt: textOf(row["createdAt"]),
      }),
    );
  }
  return { candidates, errors };
}

function unreadTracker(signal: Signal): CollectionError {
  return collectionError(
    signal.name,
    "open issues were not read because the tracker could not be, so an issue already linked to a tracker item could not be told from one nobody has promoted",
  );
}

export async function readCandidates(
  project: Project,
  options: ReadCandidatesOptions = {},
): Promise<CollectedCandidates> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const linked = options.linked === undefined ? undefined : linkedKeys(options.linked);
  const collected: CollectedCandidates = { signals: [], candidates: [], errors: [] };
  const seen = new Set<string>();
  for (const repo of project.repos) {
    const slug = remoteSlugOf(repo.path);
    if (slug === undefined || !GITHUB_SLUG.test(slug) || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const signal = signalOf(slug);
    collected.signals.push(signal);
    if (linked === undefined) {
      collected.errors.push(unreadTracker(signal));
      continue;
    }
    const read = await issuesOf(repo.name, slug, linked, env, timeoutMs);
    collected.candidates.push(...read.candidates);
    collected.errors.push(...read.errors);
  }
  return collected;
}
