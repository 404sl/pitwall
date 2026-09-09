import { elapsed } from "./format.js";

export * from "../src/board.js";

export const SNAPSHOT_STALE_AFTER_MS = 10 * 60_000;

export interface SnapshotAge {
  label: string;
  stale: boolean;
  valid: boolean;
}

export function snapshotAge(generatedAt: string, nowMs: number): SnapshotAge {
  const at = new Date(generatedAt).getTime();
  if (Number.isNaN(at)) {
    return { label: generatedAt, stale: false, valid: false };
  }
  const since = Math.max(0, nowMs - at);
  return { label: elapsed(since), stale: since >= SNAPSHOT_STALE_AFTER_MS, valid: true };
}
