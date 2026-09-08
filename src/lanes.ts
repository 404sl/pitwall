import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CollectionError, Lane } from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";

export const LOCK_ROOT = "/tmp";
export const STALE_AFTER_MINUTES = 20;
export const REWORK_SUFFIX = "-rework";
export const VERIFIED_LABEL = "lane-verified";
const FIND_OUTPUT_LIMIT = 64 * 1024 * 1024;
const HANDOFF_LIMIT = "200";
const HANDOFF_TIMEOUT_MS = 30_000;

export interface LaneOptions {
  lockRoot?: string;
  lanes?: number;
  repos?: readonly string[];
}

export interface LaneReading {
  lanes: Lane[];
  errors: CollectionError[];
}

export function slotsPath(lockPrefix: string, lockRoot: string = LOCK_ROOT): string {
  return join(lockRoot, `${lockPrefix}-slots`);
}

export function worktreePath(
  lockPrefix: string,
  issueId: string,
  lockRoot: string = LOCK_ROOT,
): string {
  return join(lockRoot, `${lockPrefix}-worktrees`, issueId);
}

export function worktreePaths(
  lockPrefix: string,
  issueId: string,
  lockRoot: string = LOCK_ROOT,
): string[] {
  return [issueId, `${issueId}${REWORK_SUFFIX}`].map((name) =>
    worktreePath(lockPrefix, name, lockRoot),
  );
}

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function claimedSlots(dir: string): number[] {
  return readdirSync(dir)
    .map((entry) => Number(entry))
    .filter((slot) => Number.isInteger(slot) && slot > 0);
}

function claimOf(dir: string, slot: number): string | undefined {
  const id = readFileSync(join(dir, String(slot)), "utf8").trim();
  return id === "" ? undefined : id;
}

export function recencyArgs(worktree: string): string[] {
  return [worktree, "-mmin", `-${STALE_AFTER_MINUTES}`];
}

function refused(what: string, ran: SpawnSyncReturns<string>): Error {
  const detail = (ran.stderr ?? "").trim() || ran.error?.message || "";
  return new Error(detail === "" ? what : `${what}: ${detail}`);
}

export function handoffArgs(): string[] {
  return [
    "pr",
    "list",
    "--state",
    "open",
    "--label",
    VERIFIED_LABEL,
    "--limit",
    HANDOFF_LIMIT,
    "--json",
    "headRefName",
  ];
}

function branchesOf(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) {
    throw new TypeError("output is not an array of pull requests");
  }
  return parsed.map((entry) => {
    const branch = (entry as Record<string, unknown> | null)?.["headRefName"];
    return typeof branch === "string" ? branch : "";
  });
}

function labelledIn(repo: string, errors: CollectionError[]): string[] {
  const listed = spawnSync("gh", handoffArgs(), {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: FIND_OUTPUT_LIMIT,
    timeout: HANDOFF_TIMEOUT_MS,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    errors.push(
      collectionError(repo, refused("labelled pull requests could not be listed", listed)),
    );
    return [];
  }
  try {
    return branchesOf(JSON.parse(listed.stdout ?? ""));
  } catch (cause) {
    errors.push(collectionError(repo, cause));
    return [];
  }
}

function mentions(text: string, issueId: string): boolean {
  const escaped = issueId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![.A-Za-z0-9])`).test(text);
}

function handoffReader(
  repos: readonly string[],
  errors: CollectionError[],
): (issueId: string) => boolean {
  let labelled: string[] | undefined;
  return (issueId) => {
    labelled ??= repos.flatMap((repo) => labelledIn(repo, errors));
    return labelled.some((branch) => mentions(branch, issueId));
  };
}

function touchedSince(worktree: string): string[] | Error {
  const found = spawnSync("find", recencyArgs(worktree), {
    encoding: "utf8",
    maxBuffer: FIND_OUTPUT_LIMIT,
  });
  if (found.error !== undefined || found.status !== 0) {
    return refused("recency could not be measured", found);
  }
  return (found.stdout ?? "").split("\n").filter((line) => line !== "");
}

function newestOf(paths: readonly string[]): string | undefined {
  let newest = 0;
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      continue;
    }
  }
  return newest === 0 ? undefined : new Date(newest).toISOString();
}

interface Probe {
  worktree: string;
  live: boolean;
  lastActivityAt?: string;
}

function probeOf(worktree: string, errors: CollectionError[]): Probe {
  const touched = touchedSince(worktree);
  if (touched instanceof Error) {
    errors.push(collectionError(worktree, touched));
    return { worktree, live: true };
  }
  if (touched.length === 0) {
    return { worktree, live: false };
  }
  return { worktree, live: true, lastActivityAt: newestOf(touched) };
}

function freshestOf(probes: readonly Probe[]): Probe | undefined {
  let freshest: Probe | undefined;
  for (const probe of probes) {
    if (!probe.live) {
      continue;
    }
    if (freshest === undefined || (probe.lastActivityAt ?? "") > (freshest.lastActivityAt ?? "")) {
      freshest = probe;
    }
  }
  return freshest;
}

interface Registry {
  dir: string;
  lockPrefix: string;
  lockRoot: string | undefined;
  handedOff: (issueId: string) => boolean;
  errors: CollectionError[];
}

function laneAt(slot: number, registry: Registry): Lane {
  const { dir, lockPrefix, lockRoot, errors } = registry;
  let issueId: string | undefined;
  try {
    issueId = claimOf(dir, slot);
  } catch (cause) {
    if (!isMissing(cause)) {
      errors.push(collectionError(join(dir, String(slot)), cause));
    }
  }
  if (issueId === undefined) {
    return { slot, state: "idle", executor: "local" };
  }
  const trees = worktreePaths(lockPrefix, issueId, lockRoot).filter((path) => existsSync(path));
  if (trees.length === 0) {
    return registry.handedOff(issueId)
      ? { slot, state: "handed-off", executor: "local", issueId }
      : { slot, state: "working", executor: "local", issueId };
  }
  const live = freshestOf(trees.map((worktree) => probeOf(worktree, errors)));
  if (live === undefined) {
    return { slot, state: "stranded", executor: "local", issueId, worktree: trees[0] };
  }
  return {
    slot,
    state: "working",
    executor: "local",
    issueId,
    worktree: live.worktree,
    lastActivityAt: live.lastActivityAt,
  };
}

export function readLanes(lockPrefix: string, options: LaneOptions = {}): LaneReading {
  const dir = slotsPath(lockPrefix, options.lockRoot);
  let claimed: number[];
  try {
    claimed = claimedSlots(dir);
  } catch (cause) {
    return { lanes: [], errors: isMissing(cause) ? [] : [collectionError(dir, cause)] };
  }
  const slots = new Set(claimed);
  for (let slot = 1; slot <= (options.lanes ?? 0); slot += 1) {
    slots.add(slot);
  }
  const errors: CollectionError[] = [];
  const registry: Registry = {
    dir,
    lockPrefix,
    lockRoot: options.lockRoot,
    handedOff: handoffReader(options.repos ?? [], errors),
    errors,
  };
  const lanes = [...slots].sort((a, b) => a - b).map((slot) => laneAt(slot, registry));
  return { lanes, errors };
}
