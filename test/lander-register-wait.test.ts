import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };
const BRANCH = "devloop/zz-aaa1";

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(
    ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv],
    { cwd },
  );
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function write(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

function stubs(root: string, bare: string, rollup: string, registersOnPoll: number): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const polls = join(root, "polls.log");
  write(
    bin,
    "gh",
    `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"master"}}' ;;
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "api "*/pulls/*)
    echo '{"base":{"ref":"master"},"labels":[{"name":"lane-verified"}],"head":{"sha":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse refs/heads/${BRANCH} 2>/dev/null)"'"}}' ;;
  "api "*/check-runs)
    echo "$2" >> ${JSON.stringify(polls)}
    if [ "$(wc -l < ${JSON.stringify(polls)})" -ge ${registersOnPoll} ]; then
      echo '{"total_count":1,"check_runs":${rollup}}'
    else
      echo '{"total_count":0,"check_runs":[]}'
    fi ;;
  *)           exit 0 ;;
esac
`,
  );
  write(
    bin,
    "git-guard",
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

function workspace(masterMoves: boolean) {
  const root = mkdtempSync(join(tmpdir(), "lander-register-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, "README.md", "first\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  git(repo, "checkout", "--quiet", "-b", BRANCH);
  write(repo, "fix.txt", "the change a lane made\n");
  git(repo, "add", "fix.txt");
  git(repo, "commit", "-m", "the change a lane made");
  git(repo, "push", "--quiet", "-u", "origin", BRANCH);

  git(repo, "checkout", "--quiet", "master");
  if (masterMoves) {
    write(repo, "README.md", "first\nsomething else landed\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "something else landed");
    git(repo, "push", "--quiet", "origin", "master");
  }
  return { root, bare, repo, polls: join(root, "polls.log") };
}

function run(root: string, repo: string, bin: string, wait: string, checksWait = "30") {
  const ran = spawnSync(
    "bash",
    [
      join(SKILL, "land-one.sh"),
      "--repo-path",
      repo,
      "--slug",
      "acme/site",
      "--pr",
      "101",
      "--branch",
      BRANCH,
      "--prefix",
      `landregister-${process.pid}`,
      "--register-wait",
      wait,
      "--register-interval",
      "0",
      "--checks-wait",
      checksWait,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...GIT_ENV,
        HOME: root,
      },
    },
  );
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

function pollsOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("a rebase push waits for a check to register on the pushed head, then merges in the same round", () => {
  const box = workspace(true);
  const bin = stubs(box.root, box.bare, '[{"name":"CI","status":"completed","conclusion":"success"}]', 3);

  const ran = run(box.root, box.repo, bin, "30");

  assert.match(ran.out, /^pushed: devloop\/zz-aaa1 was 1 behind master/m, ran.out);
  assert.doesNotMatch(
    ran.out,
    /^not_ready:/m,
    "the rollup was read in the first seconds after the script's own push, before GitHub had " +
      `registered a run on the new head, and a green branch was requeued for a later round:\n${ran.out}`,
  );
  assert.match(ran.out, /^ready: acme\/site#101/m, ran.out);
  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);

  const polls = pollsOf(box.polls);
  assert.equal(polls.length, 3, `the check-runs endpoint was not polled until a check registered: ${polls.join(", ")}`);
  const pushed = git(box.bare, "rev-parse", `refs/heads/${BRANCH}`);
  for (const path of polls) {
    assert.equal(path, `repos/acme/site/commits/${pushed}/check-runs`, "the poll did not name the head that was just pushed");
  }
});

test("a rebase push whose checks never register is not ready when the wait runs out", () => {
  const box = workspace(true);
  const bin = stubs(box.root, box.bare, "[]", 1000);

  const ran = run(box.root, box.repo, bin, "3");

  assert.match(ran.out, /^pushed:/m, ran.out);
  assert.match(ran.out, /^not_ready: no check registered on [0-9a-f]{40} within 3s of the push/m, ran.out);
  assert.doesNotMatch(ran.out, /^red:/m, `a head with no checks yet was reported as red:\n${ran.out}`);
  assert.equal(ran.code, 7, `${ran.out}\n${ran.err}`);
  assert.ok(pollsOf(box.polls).length >= 2, "the wait gave up after a single poll");
});

test("an empty rollup on a branch that was not pushed is still not ready, with no wait", () => {
  const box = workspace(false);
  const bin = stubs(box.root, box.bare, "[]", 1000);

  const ran = run(box.root, box.repo, bin, "30");

  assert.match(ran.out, /^current:/m, ran.out);
  assert.match(ran.out, /^not_ready: rollup is empty on 101 - no check has registered, which is not a pass$/m, ran.out);
  assert.equal(ran.code, 7, `${ran.out}\n${ran.err}`);
  const head = git(box.bare, "rev-parse", `refs/heads/${BRANCH}`);
  assert.deepEqual(
    pollsOf(box.polls),
    [`repos/acme/site/commits/${head}/check-runs`],
    "a branch the script did not push was polled for registration instead of being read once",
  );
});

test("a check that registered but has not concluded is waited for, then read as ready", () => {
  const box = workspace(true);
  const bin = stubs(box.root, box.bare, '[{"name":"CI","status":"completed","conclusion":"success"}]', 3);
  const polls = join(box.root, "polls.log");
  write(box.root, "polls.log", "");
  const gh = readFileSync(join(bin, "gh"), "utf8").replace(
    `echo '{"total_count":0,"check_runs":[]}'`,
    `echo '{"total_count":1,"check_runs":[{"name":"CI","status":"in_progress","conclusion":null}]}'`,
  );
  writeFileSync(join(bin, "gh"), gh);

  const ran = run(box.root, box.repo, bin, "30");

  assert.match(ran.out, /^registered: 1 check\(s\) on [0-9a-f]{40} after \d+s$/m, ran.out);
  assert.doesNotMatch(ran.out, /^not_ready:/m, `a check still running when first read was requeued instead of waited for:\n${ran.out}`);
  assert.match(ran.out, /^ready: acme\/site#101/m, ran.out);
  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.equal(pollsOf(polls).length, 3, `the check-runs endpoint was not polled until the run concluded: ${pollsOf(polls).join(", ")}`);
});

test("a check that never concludes is not ready when the checks wait runs out", () => {
  const box = workspace(true);
  const bin = stubs(box.root, box.bare, '[{"name":"CI","status":"queued","conclusion":null}]', 1);

  const ran = run(box.root, box.repo, bin, "30", "2");

  assert.match(ran.out, /^registered: 1 check\(s\)/m, ran.out);
  assert.match(ran.out, /^not_ready: CI on 101 has not concluded yet/m, ran.out);
  assert.doesNotMatch(ran.out, /^red:/m, `a check still queued was reported as red:\n${ran.out}`);
  assert.equal(ran.code, 7, `${ran.out}\n${ran.err}`);
  assert.ok(pollsOf(box.polls).length >= 2, "the checks wait gave up after a single poll");
});
