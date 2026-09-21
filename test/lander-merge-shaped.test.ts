import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };
const PREFIX = `mergeshaped-${process.pid}`;
const WORK = join("src", "board.ts");

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function tryGit(cwd: string, ...argv: string[]) {
  return spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
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
  "repo view") echo '{"defaultBranchRef":{"name":"master"}}' ;;
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr checks") exit 0 ;;
  "api repos/"*) echo '{"total_count":1,"check_runs":[{"name":"CI"}]}' ;;
  "pr view")   echo '{"baseRefName":"master","labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"SUCCESS"}],"headRefOid":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse "refs/heads/$BRANCH_UNDER_TEST" 2>/dev/null)"'"}' ;;
  *) exit 0 ;;
esac
`,
  );
  writeFileSync(
    join(bin, "git-guard"),
    `#!/bin/bash
while [ $# -gt 0 ]; do
  [ "$1" = "--" ] && { shift; break; }
  shift
done
exec "$@"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git-guard"), 0o755);
  return bin;
}

function breakMergeCount(bin: string): void {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "no git on PATH to delegate to");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash
for a in "$@"; do
  [ "$a" = "--merges" ] && { echo "fatal: bad object" >&2; exit 128; }
done
exec ${real} "$@"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lander-merge-shaped-"));
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

function onMaster(repo: string, body: string, subject: string, file = WORK): void {
  git(repo, "checkout", "--quiet", "master");
  write(repo, file, body);
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

function resolveMasterInto(repo: string, branch: string, resolution: string): void {
  git(repo, "checkout", "--quiet", branch);
  const merged = tryGit(repo, "merge", "--no-ff", "master");
  assert.notEqual(merged.status, 0, "the merge did not conflict, so the resolution edit would not be unique to it");
  write(repo, WORK, resolution);
  git(repo, "add", "-A");
  git(repo, "commit", "--no-edit");
  git(repo, "push", "--quiet", "origin", branch);
  git(repo, "checkout", "--quiet", "master");
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

test("land-one.sh merges master into a merge-shaped branch that fell behind and pushes the fast-forward", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-merged", WORK, "export const lanes = 2;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");
  resolveMasterInto(box.repo, "devloop/zz-merged", "export const lanes = 2 + 3;\n");
  onMaster(box.repo, "export const pit = 1;\n", "master moves again", join("src", "pit.ts"));

  const head = git(box.repo, "rev-parse", "origin/devloop/zz-merged");
  const master = git(box.repo, "rev-parse", "origin/master");
  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-merged", "301");

  assert.equal(
    ran.code,
    0,
    "a branch that carries a merge commit of its own and fell behind was refused instead of having " +
      "master merged in. Nothing dispatches that refusal - the label stays on, no tracker item is " +
      `written, and the branch is re-logged and skipped every round until a person moves it:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /^pushed:/m, ran.out);
  assert.doesNotMatch(ran.out, /^(merge_shaped|conflict|red):/m, ran.out);
  git(box.repo, "fetch", "--quiet", "origin");
  const after = git(box.repo, "rev-parse", "origin/devloop/zz-merged");
  assert.notEqual(after, head, "the branch was not pushed");
  assert.equal(
    tryGit(box.repo, "merge-base", "--is-ancestor", head, after).status,
    0,
    "the old head is not an ancestor of the new one, so the branch was rewritten rather than fast-forwarded",
  );
  assert.equal(
    tryGit(box.repo, "merge-base", "--is-ancestor", master, after).status,
    0,
    "the pushed head does not contain master, so the branch is still behind",
  );
  assert.equal(
    git(box.repo, "show", "origin/devloop/zz-merged:" + WORK),
    "export const lanes = 2 + 3;",
    "the resolution that exists only inside the merge commit is gone",
  );
  assert.equal(git(box.repo, "show", "origin/devloop/zz-merged:" + join("src", "pit.ts")), "export const pit = 1;");
  assert.equal(existsSync(join("/tmp", `${PREFIX}-worktrees`, "land-301")), false, "the worktree was left behind");
});

test("land-one.sh reports a merge-shaped branch whose merge with master conflicts as a conflict, untouched", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-clash", WORK, "export const lanes = 2;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");
  resolveMasterInto(box.repo, "devloop/zz-clash", "export const lanes = 2 + 3;\n");
  onMaster(box.repo, "export const lanes = 3;\nexport const pits = 1;\n", "master moves again on the same lines");

  const head = git(box.repo, "rev-parse", "origin/devloop/zz-clash");
  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-clash", "305");

  assert.equal(ran.code, 3, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, new RegExp(`^conflict: devloop/zz-clash conflicts with master in: ${WORK}`, "m"), ran.out);
  assert.doesNotMatch(ran.out, /^(merge_shaped|pushed|usage):/m, ran.out);
  git(box.repo, "fetch", "--quiet", "origin");
  assert.equal(git(box.repo, "rev-parse", "origin/devloop/zz-clash"), head, "the branch was pushed with a conflict half-merged");
  assert.equal(
    git(box.repo, "show", "origin/devloop/zz-clash:" + WORK),
    "export const lanes = 2 + 3;",
    "the resolution that exists only inside the merge commit is gone",
  );
  assert.equal(existsSync(join("/tmp", `${PREFIX}-worktrees`, "land-305")), false, "the worktree was left behind after the merge was aborted");
});

test("land-one.sh rebases a linear branch that is behind master exactly as before", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-linear", join("src", "pit.ts"), "export const pit = 1;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");

  const head = git(box.repo, "rev-parse", "origin/devloop/zz-linear");
  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-linear", "302");

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^pushed:/m, ran.out);
  git(box.repo, "fetch", "--quiet", "origin");
  assert.notEqual(git(box.repo, "rev-parse", "origin/devloop/zz-linear"), head, "a branch behind master was not rebased");
});

test("land-one.sh leaves a merge-shaped branch that is already on top of master alone", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-current", WORK, "export const lanes = 2;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");
  resolveMasterInto(box.repo, "devloop/zz-current", "export const lanes = 2 + 3;\n");

  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-current", "303");

  assert.equal(
    ran.code,
    0,
    "a merge-shaped branch that no rebase would touch was deferred anyway, which parks landable " +
      `work forever - nothing is ever going to make that branch linear:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /^current:/m, ran.out);
});

test("land-one.sh refuses to rebase when it cannot count the branch's merge commits", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-unreadable", join("src", "pit.ts"), "export const pit = 1;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");
  breakMergeCount(box.bin);

  const head = git(box.repo, "rev-parse", "origin/devloop/zz-unreadable");
  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-unreadable", "304");

  assert.equal(
    ran.code,
    6,
    "the guard read nothing and took that for 'no merge commits', so a branch whose shape is " +
      `unknown went to the rebase that silently drops a merge resolution:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /^usage: could not count merge commits/m, ran.out);
  git(box.repo, "fetch", "--quiet", "origin");
  assert.equal(git(box.repo, "rev-parse", "origin/devloop/zz-unreadable"), head, "the branch was rebased on an unreadable count");
  assert.equal(
    existsSync(join("/tmp", `${PREFIX}-worktrees`, "land-304")),
    false,
    "the run reached the worktree it only creates on its way to the rebase",
  );
});
