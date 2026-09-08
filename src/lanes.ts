import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CollectionError, Lane } from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";

export const LOCK_ROOT = "/tmp";
export const STALE_AFTER_MINUTES = 20;
const FIND_OUTPUT_LIMIT = 64 * 1024 * 1024;

export interface LaneOptions {
  lockRoot?: string;
  lanes?: number;
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

function unmeasured(found: SpawnSyncReturns<string>): Error {
  const detail = (found.stderr ?? "").trim() || found.error?.message || "";
  return new Error(
    detail === "" ? "recency could not be measured" : `recency could not be measured: ${detail}`,
  );
}

function touchedSince(worktree: string): string[] | Error {
  const found = spawnSync("find", recencyArgs(worktree), {
    encoding: "utf8",
    maxBuffer: FIND_OUTPUT_LIMIT,
  });
  if (found.error !== undefined || found.status !== 0) {
    return unmeasured(found);
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

function laneAt(
  slot: number,
  dir: string,
  lockPrefix: string,
  lockRoot: string | undefined,
  errors: CollectionError[],
): Lane {
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
  const worktree = worktreePath(lockPrefix, issueId, lockRoot);
  if (!existsSync(worktree)) {
    return { slot, state: "handed-off", executor: "local", issueId };
  }
  const touched = touchedSince(worktree);
  if (touched instanceof Error) {
    errors.push(collectionError(worktree, touched));
    return { slot, state: "working", executor: "local", issueId, worktree };
  }
  if (touched.length === 0) {
    return { slot, state: "stranded", executor: "local", issueId, worktree };
  }
  return {
    slot,
    state: "working",
    executor: "local",
    issueId,
    worktree,
    lastActivityAt: newestOf(touched),
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
  const lanes = [...slots]
    .sort((a, b) => a - b)
    .map((slot) => laneAt(slot, dir, lockPrefix, options.lockRoot, errors));
  return { lanes, errors };
}
