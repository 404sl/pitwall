import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  Issue,
  resolveOrigin,
  type Classification,
  type CollectionError,
  type Lane,
  type Origin,
} from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";
import { classify, type ClassifyContext, type UnclassifiedIssue } from "./classify.js";

const run = promisify(execFile);

export const BEADS_DIR = ".beads";
export const BEADS_DIR_VAR = "BEADS_DIR";

const MAX_OUTPUT = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

type Status = UnclassifiedIssue["status"];

const STATUSES_ARGS = ["statuses", "--json"];
const LIST_ARGS = ["list", "--all", "--limit", "0", "--json"];
const BLOCKED_ARGS = ["blocked", "--json"];

const LIST_COMMAND = ["bd", ...LIST_ARGS].join(" ");

const STORED_STATUS = new Map<string, Status>([
  ["open", "open"],
  ["in_progress", "in_progress"],
  ["blocked", "open"],
  ["deferred", "open"],
  ["closed", "closed"],
  ["pinned", "open"],
  ["hooked", "in_progress"],
]);

const STORED_CLASSIFICATION = new Map<string, Classification>([
  ["blocked", "blocked"],
  ["deferred", "parked:roadmap"],
  ["pinned", "parked:watch"],
]);

const CATEGORY_STATUS = new Map<string, Status>([
  ["active", "open"],
  ["wip", "in_progress"],
  ["frozen", "open"],
  ["done", "closed"],
]);

const CATEGORY_CLASSIFICATION = new Map<string, Classification>([["frozen", "parked:roadmap"]]);

export interface ReadIssuesOptions {
  env?: Record<string, string | undefined>;
  lanes?: readonly Lane[];
  errors: readonly CollectionError[];
  timeoutMs?: number;
}

export interface ClosedIssue extends UnclassifiedIssue {
  closedAt: string | undefined;
}

export interface IssueText {
  description: string | undefined;
  notes: string | undefined;
}

export interface CollectedIssues {
  issues: Issue[];
  closed: ClosedIssue[];
  texts: Map<string, IssueText>;
  errors: CollectionError[];
}

function failureOf(cause: unknown, timeoutMs: number): string {
  const failed = cause as { killed?: unknown; stderr?: unknown } | null;
  if (failed?.killed === true) {
    return `timed out after ${timeoutMs}ms`;
  }
  const stderr = failed?.stderr;
  const reported = typeof stderr === "string" ? stderr.trim() : "";
  if (reported !== "") {
    return reported.split("\n")[0] ?? reported;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

async function bd<T>(
  args: readonly string[],
  beadsDir: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  shape: (parsed: unknown) => T,
): Promise<T> {
  const command = ["bd", ...args].join(" ");
  let stdout: string;
  try {
    ({ stdout } = await run("bd", args as string[], {
      encoding: "utf8",
      env: { ...env, [BEADS_DIR_VAR]: beadsDir },
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

function asRecord(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("output is not an object");
  }
  return parsed as Record<string, unknown>;
}

function categoriesOf(reported: Record<string, unknown>): Map<string, string> {
  const categories = new Map<string, string>();
  for (const key of ["built_in_statuses", "custom_statuses"]) {
    const listed = reported[key];
    if (!Array.isArray(listed)) continue;
    for (const entry of listed) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, category } = entry as Record<string, unknown>;
      if (typeof name === "string" && typeof category === "string") {
        categories.set(name, category);
      }
    }
  }
  return categories;
}

interface Mapping {
  status: Status;
  parked: Classification | undefined;
}

function mappingOf(stored: string, id: string, categories: ReadonlyMap<string, string>): Mapping {
  const known = STORED_STATUS.get(stored);
  if (known !== undefined) {
    return { status: known, parked: STORED_CLASSIFICATION.get(stored) };
  }
  const category = categories.get(stored);
  if (category === undefined) {
    throw new Error(`${LIST_COMMAND}: ${id} has the unknown stored status ${stored}`);
  }
  const byCategory = CATEGORY_STATUS.get(category);
  if (byCategory === undefined) {
    throw new Error(
      `${LIST_COMMAND}: ${id} has the stored status ${stored} in the unknown category ${category}`,
    );
  }
  return { status: byCategory, parked: CATEGORY_CLASSIFICATION.get(category) };
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function labelsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((label): label is string => typeof label === "string") : [];
}

function originOf(value: unknown): Origin | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const origin = (value as Record<string, unknown>)["origin"];
  if (typeof origin !== "object" || origin === null) return undefined;
  const { session, ref } = origin as Record<string, unknown>;
  if (typeof session !== "string" || typeof ref !== "string") return undefined;
  return { session, ref };
}

function blockedEdges(rows: readonly Record<string, unknown>[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const row of rows) {
    const id = row["id"];
    if (typeof id !== "string") continue;
    edges.set(id, labelsOf(row["blocked_by"]));
  }
  return edges;
}

function toIssue(
  row: Record<string, unknown>,
  categories: ReadonlyMap<string, string>,
  edges: ReadonlyMap<string, string[]>,
  parked: Map<string, Classification>,
  texts: Map<string, IssueText>,
): ClosedIssue {
  const id = row["id"];
  if (typeof id !== "string") {
    throw new TypeError("an issue has no id");
  }
  const stored = row["status"];
  if (typeof stored !== "string") {
    throw new Error(`${LIST_COMMAND}: ${id} has no stored status`);
  }
  const mapping = mappingOf(stored, id, categories);
  if (mapping.parked !== undefined) {
    parked.set(id, mapping.parked);
  }
  texts.set(id, { description: textOf(row["description"]), notes: textOf(row["notes"]) });
  return {
    id,
    title: typeof row["title"] === "string" ? row["title"] : id,
    status: mapping.status,
    issueType: textOf(row["issue_type"]),
    priority: typeof row["priority"] === "number" ? row["priority"] : undefined,
    labels: labelsOf(row["labels"]),
    createdAt: textOf(row["created_at"]),
    updatedAt: textOf(row["updated_at"]),
    blockedBy: edges.get(id) ?? [],
    origin: originOf(row["metadata"]),
    closedAt: textOf(row["closed_at"]),
  };
}

export async function readIssues(
  root: string,
  options: ReadIssuesOptions,
): Promise<CollectedIssues> {
  const beadsDir = join(resolve(root), BEADS_DIR);
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  try {
    const categories = categoriesOf(await bd(STATUSES_ARGS, beadsDir, env, timeoutMs, asRecord));
    const rows = await bd(LIST_ARGS, beadsDir, env, timeoutMs, asRows);
    const edges = blockedEdges(await bd(BLOCKED_ARGS, beadsDir, env, timeoutMs, asRows));
    const parked = new Map<string, Classification>();
    const texts = new Map<string, IssueText>();
    const all = rows.map((row) => toIssue(row, categories, edges, parked, texts));
    const active = all.filter((issue) => issue.status !== "closed");
    const closed = all.filter((issue) => issue.status === "closed");
    const byId = new Map(all.map((issue) => [issue.id, issue]));
    const context: ClassifyContext = {
      issues: all,
      lanes: options.lanes ?? [],
      collectionComplete: options.errors.length === 0,
      stored: parked,
    };
    const issues = active.map((issue) =>
      Issue.parse({
        ...issue,
        origin: resolveOrigin(issue, byId),
        classification: classify(issue, context),
      }),
    );
    return { issues, closed, texts, errors: [] };
  } catch (cause) {
    return { issues: [], closed: [], texts: new Map(), errors: [collectionError(beadsDir, cause)] };
  }
}
