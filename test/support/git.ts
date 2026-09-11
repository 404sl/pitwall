import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function nullGlobalGitConfig(): void {
  Object.assign(process.env, GIT_ENV);
}

export function spawnGit(
  args: readonly string[],
  options: { cwd?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    ...options,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
}
