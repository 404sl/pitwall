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
