import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };
const WORK = join("src", "board.ts");

let sequence = 0;

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

function stubs(root: string, bare: string, base: string): string {
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
  "pr view")
    case "$*" in
      *baseRefName*) ${base} ;;
      *) echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"SUCCESS"}],"headRefOid":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse "refs/heads/$BRANCH_UNDER_TEST" 2>/dev/null)"'"}' ;;
    esac ;;
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

function workspace(base: string) {
  const root = mkdtempSync(join(tmpdir(), "lander-pr-base-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  const prefix = `prbase${process.pid}x${(sequence += 1)}`;

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, WORK, "export const lanes = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  git(repo, "checkout", "--quiet", "-b", "devloop/zz-base");
  write(repo, join("src", "pit.ts"), "export const pit = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "work on src/pit.ts");
  git(repo, "push", "--quiet", "-u", "origin", "devloop/zz-base");

  git(repo, "checkout", "--quiet", "master");
  write(repo, WORK, "export const lanes = 2;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "master moves under the branch");
  git(repo, "push", "--quiet", "origin", "master");

  return { root, bare, repo, prefix, bin: stubs(root, bare, base) };
}

function landOne(box: { root: string; repo: string; bin: string; prefix: string }, pr: string) {
  const ran = spawnSync(
    "bash",
    [
      join(SKILL, "land-one.sh"),
      "--repo-path", box.repo, "--slug", "acme/site", "--pr", pr, "--branch", "devloop/zz-base", "--prefix", box.prefix,
      "--register-wait", "0",
    ],
    {
      cwd: box.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${box.bin}:${process.env.PATH}`,
        ...GIT_ENV,
        BRANCH_UNDER_TEST: "devloop/zz-base",
        HOME: box.root,
      },
    },
  );
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

function clean(box: { root: string; prefix: string }): void {
  rmSync(join("/tmp", `${box.prefix}-worktrees`), { recursive: true, force: true });
  rmSync(box.root, { recursive: true, force: true });
}

test("land-one.sh refuses a pull request open against a branch other than its base, naming both, before cutting a worktree", () => {
  const box = workspace(`echo '{"baseRefName":"main"}'`);
  try {
    const before = git(box.bare, "rev-parse", "refs/heads/devloop/zz-base");

    const ran = landOne(box, "501");

    assert.equal(
      ran.code,
      6,
      "a pull request open against main was landed as if it were open against master - the rebase " +
        `goes onto one branch and the merge lands on the other:\n${ran.out}\n${ran.err}`,
    );
    assert.match(ran.out, /^usage:/m, ran.out);
    assert.match(ran.out, /'master'/, `the refusal does not name the base the run was handed:\n${ran.out}`);
    assert.match(ran.out, /'main'/, `the refusal does not name the branch the pull request is open against:\n${ran.out}`);
    assert.match(ran.out, /acme\/site#501/, `the refusal does not name the pull request:\n${ran.out}`);
    assert.match(ran.out, /gh pr edit 501 --repo acme\/site --base master/, `the refusal does not say how to retarget it:\n${ran.out}`);
    assert.equal(git(box.bare, "rev-parse", "refs/heads/devloop/zz-base"), before, "the branch head was moved");
    assert.equal(existsSync(join("/tmp", `${box.prefix}-worktrees`, "land-501")), false, "a worktree was cut before the refusal");
  } finally {
    clean(box);
  }
});

test("land-one.sh lands a pull request whose base agrees with the one it was handed", () => {
  const box = workspace(`echo '{"baseRefName":"master"}'`);
  try {
    const before = git(box.bare, "rev-parse", "refs/heads/devloop/zz-base");

    const ran = landOne(box, "502");

    assert.equal(ran.code, 0, `a pull request open against master was refused:\n${ran.out}\n${ran.err}`);
    assert.match(ran.out, /^pushed: devloop\/zz-base was 1 behind master/m, ran.out);
    assert.match(ran.out, /^ready: acme\/site#502/m, ran.out);
    const after = git(box.bare, "rev-parse", "refs/heads/devloop/zz-base");
    assert.notEqual(after, before, "nothing was pushed");
    assert.equal(git(box.bare, "merge-base", "--is-ancestor", "refs/heads/master", after), "", "the pushed head does not sit on master");
  } finally {
    clean(box);
  }
});

test("land-one.sh refuses a pull request whose base gh cannot report rather than assuming it", () => {
  const box = workspace(`echo 'HTTP 403: API rate limit exceeded' >&2; exit 1`);
  try {
    const before = git(box.bare, "rev-parse", "refs/heads/devloop/zz-base");

    const ran = landOne(box, "503");

    assert.equal(ran.code, 6, `an unreadable base was read as agreeing:\n${ran.out}\n${ran.err}`);
    assert.match(ran.out, /^usage: could not read the base branch of acme\/site#503/m, ran.out);
    assert.match(ran.out, /gh pr view 503 --repo acme\/site --json baseRefName/, `the refusal does not name the read that was attempted:\n${ran.out}`);
    assert.equal(git(box.bare, "rev-parse", "refs/heads/devloop/zz-base"), before, "the branch head was moved");
    assert.equal(existsSync(join("/tmp", `${box.prefix}-worktrees`, "land-503")), false, "a worktree was cut before the refusal");
  } finally {
    clean(box);
  }
});
