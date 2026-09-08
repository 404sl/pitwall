import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PullRequest, type CollectionError, type Project } from "@404sl/pitwall-schema";
import { collectionError, failureOf } from "./errors.js";
import { remoteSlugOf } from "./git.js";

const run = promisify(execFile);

const MAX_OUTPUT = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const LIST_LIMIT = "200";
const LIST_FIELDS = "number,title,labels,headRefName,url";
const VIEW_FIELDS = "statusCheckRollup,body";

type Checks = PullRequest["checks"];

const CONCLUSIONS = new Map<string, Checks>([
  ["SUCCESS", "green"],
  ["NEUTRAL", "green"],
  ["SKIPPED", "green"],
  ["FAILURE", "red"],
  ["TIMED_OUT", "red"],
  ["CANCELLED", "red"],
  ["ACTION_REQUIRED", "red"],
  ["STARTUP_FAILURE", "red"],
  ["STALE", "red"],
]);

const CONTEXT_STATES = new Map<string, Checks>([
  ["SUCCESS", "green"],
  ["FAILURE", "red"],
  ["ERROR", "red"],
  ["PENDING", "pending"],
  ["EXPECTED", "pending"],
]);

export interface ReadPipelineOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  knownIds?: ReadonlySet<string>;
}

export interface CollectedPipeline {
  pipeline: PullRequest[];
  errors: CollectionError[];
}

function listArgs(slug: string): string[] {
  return ["pr", "list", "--repo", slug, "--state", "open", "--limit", LIST_LIMIT, "--json", LIST_FIELDS];
}

function viewArgs(slug: string, number: number): string[] {
  return ["pr", "view", String(number), "--repo", slug, "--json", VIEW_FIELDS];
}

function commandOf(args: readonly string[]): string {
  return ["gh", ...args].join(" ");
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
    throw new TypeError("output is not an array of pull requests");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`pull request ${index} is not an object`);
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

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)["name"]
          : undefined,
    )
    .filter((name): name is string => typeof name === "string");
}

function entryChecks(entry: Record<string, unknown>): Checks {
  const state = entry["state"];
  if (typeof state === "string") {
    return CONTEXT_STATES.get(state) ?? "pending";
  }
  const status = entry["status"];
  if (typeof status !== "string" || status !== "COMPLETED") {
    return "pending";
  }
  const conclusion = entry["conclusion"];
  return typeof conclusion === "string" ? (CONCLUSIONS.get(conclusion) ?? "pending") : "pending";
}

export function rollupChecks(rollup: unknown): Checks {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return "none";
  }
  const states = rollup
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map(entryChecks);
  if (states.length === 0) {
    return "none";
  }
  if (states.includes("red")) {
    return "red";
  }
  return states.includes("pending") ? "pending" : "green";
}

function escaped(prefix: string): string {
  return prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function issueMatcher(
  idPrefix: string | undefined,
  knownIds: ReadonlySet<string>,
): (text: string) => string | undefined {
  if (idPrefix === undefined || idPrefix === "" || knownIds.size === 0) {
    return () => undefined;
  }
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])${escaped(idPrefix)}-[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*`,
    "g",
  );
  return (text) => {
    for (const found of text.matchAll(pattern)) {
      if (knownIds.has(found[0])) {
        return found[0];
      }
    }
    return undefined;
  };
}

async function pullsOf(
  name: string,
  slug: string,
  match: (text: string) => string | undefined,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<CollectedPipeline> {
  const listing = listArgs(slug);
  const errors: CollectionError[] = [];
  let rows: Record<string, unknown>[];
  try {
    rows = await gh(listing, env, timeoutMs, asRows);
  } catch (cause) {
    return { pipeline: [], errors: [collectionError(commandOf(listing), cause)] };
  }
  const pipeline: PullRequest[] = [];
  for (const row of rows) {
    const number = row["number"];
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      continue;
    }
    const viewing = viewArgs(slug, number);
    let viewed: Record<string, unknown>;
    try {
      viewed = await gh(viewing, env, timeoutMs, asRecord);
    } catch (cause) {
      errors.push(collectionError(commandOf(viewing), cause));
      continue;
    }
    const branch = textOf(row["headRefName"]);
    pipeline.push(
      PullRequest.parse({
        repo: name,
        number,
        title: textOf(row["title"]),
        issueId:
          (branch === undefined ? undefined : match(branch)) ?? match(textOf(viewed["body"]) ?? ""),
        checks: rollupChecks(viewed["statusCheckRollup"]),
        labels: labelsOf(row["labels"]),
        url: textOf(row["url"]),
      }),
    );
  }
  return { pipeline, errors };
}

export async function readPipeline(
  project: Project,
  options: ReadPipelineOptions = {},
): Promise<CollectedPipeline> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const match = issueMatcher(project.authority.idPrefix, options.knownIds ?? new Set());
  const pipeline: PullRequest[] = [];
  const errors: CollectionError[] = [];
  const seen = new Set<string>();
  for (const repo of project.repos) {
    const slug = remoteSlugOf(repo.path);
    if (slug === undefined || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const read = await pullsOf(repo.name, slug, match, env, timeoutMs);
    pipeline.push(...read.pipeline);
    errors.push(...read.errors);
  }
  return { pipeline, errors };
}
