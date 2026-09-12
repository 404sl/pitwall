import type { BuildStamp, BuildVerdict, CheckoutState, UnknownReason } from "../src/build.js";
import { elapsed, fill, shortSha } from "./format.js";
import { strings } from "./strings.js";

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

export interface RunningVersion {
  running: string;
  update?: string;
  build?: BuildStamp;
  checkout?: CheckoutState;
  buildCheck?: BuildVerdict;
  unknownBecause?: UnknownReason;
}

export type VersionAnswer =
  | { kind: "waiting" }
  | { kind: "unanswered" }
  | { kind: "read"; version: RunningVersion };

export type BuildState =
  | { kind: "behind"; branch: string; ahead: number; head: string; commit: string; at?: string }
  | { kind: "current"; branch: string; commit: string; at?: string }
  | { kind: "unknown"; commit?: string; at?: string; because: string }
  | { kind: "no-checkout"; commit?: string; at?: string }
  | { kind: "absent" };

function stamped(build: BuildStamp | undefined): { commit?: string; at?: string } {
  if (build === undefined) {
    return {};
  }
  return build.at === undefined ? { commit: build.commit } : { commit: build.commit, at: build.at };
}

function unknownBuild(build: BuildStamp | undefined, because: string): BuildState {
  return { kind: "unknown", ...stamped(build), because };
}

function reasonFor(
  reason: UnknownReason | undefined,
  build: BuildStamp | undefined,
  checkout: CheckoutState | undefined,
): string {
  if (reason === undefined) {
    return strings.build.unknown.noServer;
  }
  if (reason.kind === "no-stamp") {
    return strings.build.unknown.noStamp;
  }
  if (reason.kind === "checkout") {
    return fill(strings.build.unknown.checkout, { reason: reason.message });
  }
  if (build === undefined || checkout === undefined) {
    return strings.build.unknown.noServer;
  }
  return fill(strings.build.unknown.diverged, { commit: shortSha(build.commit), branch: checkout.branch });
}

export function buildState(answer: VersionAnswer): BuildState {
  if (answer.kind === "waiting") {
    return { kind: "absent" };
  }
  if (answer.kind === "unanswered") {
    return { kind: "unknown", because: strings.build.unknown.noServer };
  }
  const { build, checkout, buildCheck, unknownBecause } = answer.version;
  if (buildCheck === undefined) {
    return unknownBuild(build, strings.build.unknown.noServer);
  }
  if (buildCheck === "no-checkout") {
    return { kind: "no-checkout", ...stamped(build) };
  }
  if (buildCheck === "unknown") {
    return unknownBuild(build, reasonFor(unknownBecause, build, checkout));
  }
  if (build === undefined || checkout === undefined || checkout.ahead === undefined) {
    return unknownBuild(build, strings.build.unknown.noServer);
  }
  if (buildCheck === "current") {
    return { kind: "current", branch: checkout.branch, commit: build.commit, at: build.at };
  }
  if (checkout.ahead < 1) {
    return unknownBuild(build, strings.build.unknown.noServer);
  }
  return {
    kind: "behind",
    branch: checkout.branch,
    ahead: checkout.ahead,
    head: checkout.head,
    commit: build.commit,
    at: build.at,
  };
}
