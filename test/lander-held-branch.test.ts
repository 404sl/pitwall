import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };
const PREFIX = `heldbranch-${process.pid}`;
const WORK = join("src", "board.ts");

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function write(dir: string, relative: string, body: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function stubs(root: string, bare: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
case "$1 $2" in
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr checks") exit 0 ;;
  "api repos/"*) echo '{"total_count":1,"check_runs":[{"name":"CI"}]}' ;;
  "pr view")   echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"SUCCESS"}],"headRefOid":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse "refs/heads/$BRANCH_UNDER_TEST" 2>/dev/null)"'"}' ;;
  *) exit 0 ;;
esac
`,
  );
  writeFileSync(
    join(bin, "git-guard"),
    `#!/bin/bash
dir=""; branch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir=*) dir="\${1#*=}"; shift ;;
    --branch=*) branch="\${1#*=}"; shift ;;
    --) shift; break ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
if [ -n "$dir" ] && [ "$(pwd -P)" != "$(cd "$dir" && pwd -P)" ]; then
  echo "Error: Not in expected directory" >&2; exit 1
fi
if [ -n "$branch" ] && [ "$(git branch --show-current)" != "$branch" ]; then
  echo "Error: Not on expected branch" >&2; exit 1
fi
exec "$@"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git-guard"), 0o755);
  return bin;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lander-held-branch-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, WORK, "export const lanes = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  return { root, bare, repo, bin: stubs(root, bare) };
}

function onMaster(repo: string, body: string, subject: string): void {
  git(repo, "checkout", "--quiet", "master");
  write(repo, WORK, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", subject);
  git(repo, "push", "--quiet", "origin", "master");
}

function lane(repo: string, branch: string, file: string, body: string): void {
  git(repo, "checkout", "--quiet", "master");
  git(repo, "checkout", "--quiet", "-b", branch);
  write(repo, file, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `work on ${file}`);
  git(repo, "push", "--quiet", "-u", "origin", branch);
  git(repo, "checkout", "--quiet", "master");
}

function reworkElsewhere(root: string, bare: string, branch: string, file: string, body: string): string {
  const other = join(root, "rework");
  git(root, "clone", "--quiet", bare, other);
  git(other, "checkout", "--quiet", branch);
  write(other, file, body);
  git(other, "add", "-A");
  git(other, "commit", "--amend", "-m", `reworked ${file}`);
  git(other, "push", "--quiet", "--force", "origin", branch);
  return git(other, "rev-parse", "HEAD");
}

function landOne(root: string, repo: string, bin: string, branch: string, pr: string) {
  const ran = spawnSync(
    "bash",
    [join(SKILL, "land-one.sh"), "--repo-path", repo, "--slug", "acme/site", "--pr", pr, "--branch", branch, "--prefix", PREFIX],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...GIT_ENV,
        BRANCH_UNDER_TEST: branch,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "true",
        HOME: root,
      },
    },
  );
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

test("land-one.sh lands a branch that a leftover worktree still has checked out", () => {
  const box = workspace();
  const branch = "devloop/zz-held";
  lane(box.repo, branch, join("src", "pit.ts"), "export const pit = 1;\n");
  const stale = join(box.root, "stale-lane");
  git(box.repo, "worktree", "add", "--quiet", stale, branch);
  const staleHead = git(stale, "rev-parse", "HEAD");
  const pushed = reworkElsewhere(box.root, box.bare, branch, join("src", "pit.ts"), "export const pit = 2;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");

  const ran = landOne(box.root, box.repo, box.bin, branch, "401");

  assert.equal(
    ran.code,
    0,
    "a branch held by another worktree was refused instead of landed - the only thing wrong " +
      `with it is where a finished lane left its checkout:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /^pushed:/m, ran.out);
  assert.ok(!/push --force-with-lease was refused/.test(ran.out), `the refusal was reported against the push: ${ran.out}`);
  assert.ok(ran.out.includes(stale), `the run did not name the worktree holding the branch:\n${ran.out}`);

  git(box.repo, "fetch", "--quiet", "origin");
  const landed = git(box.repo, "rev-parse", `origin/${branch}`);
  assert.notEqual(landed, pushed, "the branch was not rebased onto master");
  assert.equal(git(box.repo, "merge-base", "--is-ancestor", "origin/master", landed), "", "the pushed head is not on top of master");
  assert.equal(
    git(box.repo, "show", `origin/${branch}:src/pit.ts`),
    "export const pit = 2;",
    "the pushed head carries the stale worktree's work rather than the head that was on the remote",
  );
  assert.equal(git(stale, "rev-parse", "HEAD"), staleHead, "the leftover worktree was moved by a run that owns nothing there");
  assert.ok(existsSync(stale), "the leftover worktree was removed");
  assert.equal(existsSync(join("/tmp", `${PREFIX}-worktrees`, "land-401")), false, "the land worktree was left behind");
});

test("land-one.sh refuses to take a default branch as the branch to land", () => {
  const box = workspace();
  onMaster(box.repo, "export const lanes = 3;\n", "master moves");

  const ran = landOne(box.root, box.repo, box.bin, "master", "402");

  assert.equal(ran.code, 6, `${ran.out}\n${ran.err}`);
  assert.match(ran.out + ran.err, /^usage:.*master/m, ran.out + ran.err);
});
