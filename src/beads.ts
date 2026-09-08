import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  Issue,
  resolveOrigin,
  type CollectionError,
  type Lane,
  type Origin,
} from "@404sl/pitwall-schema";
import { collectionError } from "./autofix.js";
import { classify, type UnclassifiedIssue } from "./classify.js";

export const BEADS_DIR = ".beads";
export const BEADS_DIR_VAR = "BEADS_DIR";

const MAX_OUTPUT = 64 * 1024 * 1024;

type Status = UnclassifiedIssue["status"];

const STATUSES = ["open", "in_progress", "closed"] as const satisfies readonly Status[];

export interface ReadIssuesOptions {
  env?: Record<string, string | undefined>;
  lanes?: readonly Lane[];
}

export interface CollectedIssues {
  issues: Issue[];
  closed: UnclassifiedIssue[];
  errors: CollectionError[];
}

function failureOf(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown } | null)?.stderr;
  const reported = typeof stderr === "string" ? stderr.trim() : "";
  if (reported !== "") {
    return reported.split("\n")[0] ?? reported;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function bd(
  args: readonly string[],
  beadsDir: string,
  env: Record<string, string | undefined>,
): Record<string, unknown>[] {
  const command = ["bd", ...args].join(" ");
  let stdout: string;
  try {
    stdout = execFileSync("bd", args, {
      encoding: "utf8",
      env: { ...env, [BEADS_DIR_VAR]: beadsDir },
      maxBuffer: MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new Error(`${command}: ${failureOf(cause)}`);
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      throw new TypeError("output is not an array of issues");
    }
    return parsed.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError(`issue ${index} is not an object`);
      }
      return entry as Record<string, unknown>;
    });
  } catch (cause) {
    throw new Error(`${command}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function statusOf(value: unknown, asked: Status): Status {
  return (STATUSES as readonly string[]).includes(value as string) ? (value as Status) : asked;
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
  asked: Status,
  edges: ReadonlyMap<string, string[]>,
): UnclassifiedIssue {
  const id = row["id"];
  if (typeof id !== "string") {
    throw new TypeError("an issue has no id");
  }
  return {
    id,
    title: typeof row["title"] === "string" ? row["title"] : id,
    status: statusOf(row["status"], asked),
    issueType: textOf(row["issue_type"]),
    priority: typeof row["priority"] === "number" ? row["priority"] : undefined,
    labels: labelsOf(row["labels"]),
    createdAt: textOf(row["created_at"]),
    updatedAt: textOf(row["updated_at"]),
    blockedBy: edges.get(id) ?? [],
    origin: originOf(row["metadata"]),
  };
}

export function readIssues(root: string, options: ReadIssuesOptions = {}): CollectedIssues {
  const beadsDir = join(resolve(root), BEADS_DIR);
  const env = options.env ?? process.env;
  try {
    const listed = STATUSES.map((status) =>
      bd(["list", "--status", status, "--limit", "0", "--json"], beadsDir, env),
    );
    const edges = blockedEdges(bd(["blocked", "--json"], beadsDir, env));
    const [open = [], inProgress = [], closedRows = []] = listed;
    const active = [
      ...open.map((row) => toIssue(row, "open", edges)),
      ...inProgress.map((row) => toIssue(row, "in_progress", edges)),
    ];
    const closed = closedRows.map((row) => toIssue(row, "closed", edges));
    const byId = new Map([...active, ...closed].map((issue) => [issue.id, issue]));
    const context = { issues: active, lanes: options.lanes ?? [] };
    const issues = active.map((issue) =>
      Issue.parse({
        ...issue,
        origin: resolveOrigin(issue, byId),
        classification: classify(issue, context),
      }),
    );
    return { issues, closed, errors: [] };
  } catch (cause) {
    return { issues: [], closed: [], errors: [collectionError(beadsDir, cause)] };
  }
}
