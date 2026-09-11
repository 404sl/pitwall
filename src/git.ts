import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";
const GIT_OUTPUT_LIMIT = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export function defaultBranchOf(repo: string): string | undefined {
  if (!existsSync(join(repo, ".git"))) {
    return undefined;
  }
  const read = spawnSync("git", ["symbolic-ref", ORIGIN_HEAD], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    timeout: GIT_TIMEOUT_MS,
  });
  if (read.error !== undefined || read.status !== 0) {
    return undefined;
  }
  const ref = (read.stdout ?? "").trim();
  if (!ref.startsWith(ORIGIN_PREFIX)) {
    return undefined;
  }
  const branch = ref.slice(ORIGIN_PREFIX.length);
  return branch === "" ? undefined : branch;
}

const ORIGIN = "origin";
const GITHUB_HOST = "github.com";
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const GIT_SCHEMES = new Set(["http", "https", "ssh", "git"]);
const AUTHORITY = /^([^/:]+)([:/])(.+)$/;
const PORT = /^\d+\//;

export function slugOf(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, "");
  const scheme = SCHEME.exec(trimmed);
  if (scheme !== null && !GIT_SCHEMES.has((scheme[1] ?? "").toLowerCase())) {
    return undefined;
  }
  const rest = (scheme === null ? trimmed : trimmed.slice(scheme[0].length)).replace(/^[^@/]+@/, "");
  const split = AUTHORITY.exec(rest);
  if (split === null) {
    return undefined;
  }
  const host = (split[1] ?? "").toLowerCase();
  const routed = split[3] ?? "";
  const ported = scheme !== null && split[2] === ":";
  const path = (ported ? routed.replace(PORT, "") : routed).replace(/\.git$/, "");
  if (!path.includes("/") || path.startsWith("/") || path.endsWith("/")) {
    return undefined;
  }
  return host === GITHUB_HOST ? path : `${host}/${path}`;
}

const NO_SUCH_REMOTE = 2;
const REMOTE_COMMAND = `git remote get-url ${ORIGIN}`;

export interface Remote {
  slug?: string;
  failure?: string;
}

function refusedBy(status: number | null, signal: NodeJS.Signals | null, said: string): string {
  const lines = said
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const refusal = lines.find((line) => line.startsWith("fatal:") || line.startsWith("error:"));
  const last = lines[lines.length - 1];
  if (refusal !== undefined || last !== undefined) {
    return refusal ?? last ?? "";
  }
  if (signal !== null) {
    return `${REMOTE_COMMAND} was killed by ${signal}`;
  }
  return `${REMOTE_COMMAND} exited ${status ?? "without a status"}`;
}

export function remoteOf(repo: string): Remote {
  if (!existsSync(join(repo, ".git"))) {
    return {};
  }
  const read = spawnSync("git", ["remote", "get-url", ORIGIN], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    timeout: GIT_TIMEOUT_MS,
  });
  if (read.error !== undefined) {
    return { failure: `${REMOTE_COMMAND}: ${read.error.message}` };
  }
  if (read.status === NO_SUCH_REMOTE) {
    return {};
  }
  if (read.status !== 0) {
    return { failure: refusedBy(read.status, read.signal, read.stderr ?? "") };
  }
  return { slug: slugOf(read.stdout ?? "") };
}

export function remoteSlugOf(repo: string): string | undefined {
  return remoteOf(repo).slug;
}
