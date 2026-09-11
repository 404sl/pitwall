import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGit } from "./support/git.js";

const IGNORE_FILE = fileURLToPath(new URL("../.gitignore", import.meta.url));

function git(dir: string, ...args: string[]): { status: number | null; stdout: string } {
  const ran = spawnGit(args, { cwd: dir });
  return { status: ran.status, stdout: ran.stdout };
}

function laneWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-gitignore-"));
  const shared = mkdtempSync(join(tmpdir(), "pitwall-deps-"));
  mkdirSync(join(shared, "typescript"), { recursive: true });

  const init = git(dir, "init", "--quiet");
  assert.equal(init.status, 0, "the throwaway checkout could not be created");
  copyFileSync(IGNORE_FILE, join(dir, ".gitignore"));
  symlinkSync(shared, join(dir, "node_modules"));
  return dir;
}

test("node_modules shared into a lane as a symlink is ignored", () => {
  const dir = laneWorktree();

  const ignored = git(dir, "check-ignore", "-v", "node_modules");
  assert.equal(ignored.status, 0, "no .gitignore rule matches a node_modules symlink");
  assert.match(ignored.stdout, /\.gitignore:\d+:node_modules\s/);

  const status = git(dir, "status", "--porcelain");
  assert.equal(status.status, 0);
  assert.ok(!status.stdout.includes("node_modules"), "a shared node_modules shows up as untracked");
});
