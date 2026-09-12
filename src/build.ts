import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const STAMP_FILE = fileURLToPath(new URL("build.json", import.meta.url));
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CHECK_EVERY_MS = 60_000;
export const CHECK_TIMEOUT_MS = 10_000;

const GIT_OUTPUT_LIMIT = 1024 * 1024;
const COMMIT = /^[0-9a-f]{7,40}$/;

export type BuildVerdict = "current" | "behind" | "unknown" | "no-checkout";

export interface BuildStamp {
  commit: string;
  at?: string;
}

export interface CheckoutState {
  branch: string;
  head: string;
  ahead?: number;
}

export type UnknownReason =
  | { kind: "no-stamp" }
  | { kind: "diverged" }
  | { kind: "checkout"; message: string };

export interface BuildReport {
  build?: BuildStamp;
  checkout?: CheckoutState;
  buildCheck: BuildVerdict;
  unknownBecause?: UnknownReason;
}

export interface BuildCheck {
  state: () => BuildReport;
  refresh: () => void;
}

export interface BuildCheckOptions {
  repo?: string;
  stampFile?: string;
  stamp?: BuildStamp;
  everyMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function readStamp(file: string): BuildStamp | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { commit, at } = body as { commit?: unknown; at?: unknown };
  if (typeof commit !== "string" || !COMMIT.test(commit)) {
    return undefined;
  }
  return typeof at === "string" ? { commit, at } : { commit };
}

interface GitRead {
  out?: string;
  status?: number;
  message: string;
}

function firstLine(text: string | null | undefined): string {
  const line = (text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line ?? "";
}

function git(repo: string, args: readonly string[], timeoutMs: number): GitRead {
  const read = spawnSync("git", [...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    timeout: timeoutMs,
  });
  if (read.error !== undefined) {
    return { message: read.error.message };
  }
  const status = read.status ?? undefined;
  if (status === undefined) {
    return { message: `git ${args.join(" ")} was stopped before it answered` };
  }
  const message = firstLine(read.stderr) === "" ? `git ${args.join(" ")} exited ${status}` : firstLine(read.stderr);
  return status === 0 ? { out: (read.stdout ?? "").trim(), status, message: "" } : { status, message };
}

function unreadable(build: BuildStamp | undefined, checkout: CheckoutState | undefined, message: string): BuildReport {
  return {
    ...(build === undefined ? {} : { build }),
    ...(checkout === undefined ? {} : { checkout }),
    buildCheck: "unknown",
    unknownBecause: { kind: "checkout", message },
  };
}

function compare(repo: string, build: BuildStamp, timeoutMs: number): BuildReport {
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
  if (branch.out === undefined || branch.out === "") {
    return unreadable(build, undefined, branch.message);
  }
  const head = git(repo, ["rev-parse", "HEAD"], timeoutMs);
  if (head.out === undefined || head.out === "") {
    return unreadable(build, undefined, head.message);
  }
  const checkout: CheckoutState = { branch: branch.out, head: head.out };
  const ancestor = git(repo, ["merge-base", "--is-ancestor", build.commit, "HEAD"], timeoutMs);
  if (ancestor.status === undefined) {
    return unreadable(build, checkout, ancestor.message);
  }
  if (ancestor.status !== 0) {
    return { build, checkout, buildCheck: "unknown", unknownBecause: { kind: "diverged" } };
  }
  const counted = git(repo, ["rev-list", "--count", `${build.commit}..HEAD`], timeoutMs);
  const ahead = counted.out === undefined ? Number.NaN : Number(counted.out);
  if (!Number.isInteger(ahead) || ahead < 0) {
    return unreadable(build, checkout, counted.message);
  }
  return {
    build,
    checkout: { ...checkout, ahead },
    buildCheck: ahead === 0 ? "current" : "behind",
  };
}

export function isCheckout(repo: string = PACKAGE_ROOT): boolean {
  return existsSync(join(repo, ".git"));
}

export function buildReport(repo: string, stamp: BuildStamp | undefined, timeoutMs: number): BuildReport {
  const build = stamp !== undefined && COMMIT.test(stamp.commit) ? stamp : undefined;
  if (!isCheckout(repo)) {
    return { ...(build === undefined ? {} : { build }), buildCheck: "no-checkout" };
  }
  if (build === undefined) {
    return { buildCheck: "unknown", unknownBecause: { kind: "no-stamp" } };
  }
  return compare(repo, build, timeoutMs);
}

export function createBuildCheck(options: BuildCheckOptions = {}): BuildCheck {
  const repo = options.repo ?? PACKAGE_ROOT;
  const everyMs = options.everyMs ?? CHECK_EVERY_MS;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const stamp = options.stamp ?? readStamp(options.stampFile ?? STAMP_FILE);
  let held: BuildReport | undefined;
  let readAt: number | undefined;

  const read = (): BuildReport => {
    const made = buildReport(repo, stamp, timeoutMs);
    held = made;
    readAt = now();
    return made;
  };

  return {
    state: () => (held !== undefined && readAt !== undefined && now() - readAt < everyMs ? held : read()),
    refresh: () => {
      read();
    },
  };
}
