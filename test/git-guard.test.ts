import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const GUARD = join(SKILL, "git-guard.sh");

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...argv: string[]): string {
  const run = spawnSync(
    "git",
    ["-c", "user.name=Guard Test", "-c", "user.email=guard@example.invalid", ...argv],
    { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } },
  );
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

interface Box {
  root: string;
  repo: string;
  lane: string;
  marker: string;
}

function workspace(): Box {
  const root = mkdtempSync(join(tmpdir(), "git-guard-"));
  const repo = join(root, "repo");

  git(root, "init", "--quiet", "--initial-branch=master", repo);
  writeFileSync(join(repo, "README.md"), "first\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "the first commit");

  const lane = join(root, "lane");
  git(repo, "worktree", "add", "--quiet", "-b", "devloop/zz-aaa1", lane, "master");

  return { root, repo, lane, marker: join(root, "it-ran") };
}

interface Ran {
  code: number | null;
  out: string;
  err: string;
  ran: boolean;
}

function guard(box: Box, args: string[]): Ran {
  const run = spawnSync("bash", [GUARD, ...args, "--", "touch", box.marker], {
    cwd: box.root,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  return {
    code: run.status,
    out: run.stdout ?? "",
    err: run.stderr ?? "",
    ran: existsSync(box.marker),
  };
}

function refused(ran: Ran, what: string) {
  assert.equal(
    ran.code,
    2,
    `${what}: the exit code is not the guard's own refusal code. A merely non-zero status cannot ` +
      `be told apart from a guard that was never executed - bash answers 127 for a script that is ` +
      `missing and 126 for one it cannot run - so an assertion that accepts any non-zero passes ` +
      `with the guard deleted, which is this ticket's own defect reproduced inside the test meant ` +
      `to prevent it:\n${ran.out}\n${ran.err}`,
  );
  assert.match(
    ran.err,
    /^git-guard\.sh: /m,
    `${what}: nothing on stderr came from the guard, so whatever refused was not it:\n${ran.err}`,
  );
  assert.equal(
    ran.ran,
    false,
    `${what}: the guard reported a refusal and ran the command anyway, which is worse than ` +
      `allowing it - the command happens and the caller is told it did not`,
  );
}

test("the branch a lane was given runs the command, in that worktree", () => {
  const box = workspace();

  const ran = guard(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"]);

  assert.equal(ran.code, 0, `the guard refused a lane's own branch:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the command it was given");
});

test("master is refused even from a checkout that really is on master", () => {
  const box = workspace();

  const ran = guard(box, [`--dir=${box.repo}`, "--branch=master"]);

  refused(ran, "master");
  assert.match(ran.err, /master/, `the refusal does not say what was refused:\n${ran.err}`);
});

test("main is refused as well as master, because which one is default is not ours to assume", () => {
  const box = workspace();
  git(box.lane, "checkout", "--quiet", "-b", "main");

  const ran = guard(box, [`--dir=${box.lane}`, "--branch=main"]);

  refused(ran, "main");
  assert.match(ran.err, /main/, `the refusal does not say what was refused:\n${ran.err}`);
});

test("a branch other than the one the guard was given is refused", () => {
  const box = workspace();

  const ran = guard(box, [`--dir=${box.lane}`, "--branch=devloop/zz-bbb2"]);

  refused(
    ran,
    "a command against devloop/zz-aaa1 while the caller believed it was on devloop/zz-bbb2 - " +
      "that disagreement is the evidence a cd went somewhere it was not meant to",
  );
  assert.match(ran.err, /devloop\/zz-aaa1/, `the refusal does not say which branch is checked out:\n${ran.err}`);
  assert.match(ran.err, /devloop\/zz-bbb2/, `the refusal does not say which branch was asked for:\n${ran.err}`);
});

test("a directory inside a worktree but not its root is refused", () => {
  const box = workspace();
  const sub = join(box.lane, "sub");
  mkdirSync(sub);

  const ran = guard(box, [`--dir=${sub}`, "--branch=devloop/zz-aaa1"]);

  refused(ran, "a directory that is not the root of its own worktree");
  assert.match(
    ran.err,
    /not at its own root/,
    `the refusal came from some other branch of the guard, so this test would pass with the ` +
      `root check deleted. That check is the one stopping a command meant for a lane's worktree ` +
      `from running in a main checkout:\n${ran.err}`,
  );
  assert.match(ran.err, /sub/, `the refusal does not say which directory was given:\n${ran.err}`);
});

test("a detached HEAD is refused rather than compared against the branch it was given", () => {
  const box = workspace();
  git(box.lane, "checkout", "--quiet", "--detach", "HEAD");

  const ran = guard(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"]);

  refused(ran, "a worktree with no branch checked out at all");
  assert.match(
    ran.err,
    /detached HEAD/,
    `the refusal came from the branch comparison rather than from the detached-HEAD check, so ` +
      `this test would pass with that check deleted and the caller would be told the worktree ` +
      `is on a branch it is not on:\n${ran.err}`,
  );
});

test("a directory that is no checkout at all is refused rather than run in", () => {
  const box = workspace();

  const ran = guard(box, [`--dir=${box.root}`, "--branch=devloop/zz-aaa1"]);

  refused(ran, "a directory git knows nothing about");
  assert.match(
    ran.err,
    /no worktree root/,
    `the refusal came from a later branch of the guard, so this test would pass with the ` +
      `no-worktree-root check deleted - an empty toplevel is unequal to the directory asked ` +
      `for, so the root comparison refuses it too, and the caller is told the directory sits ` +
      `inside some other worktree rather than in none:\n${ran.err}`,
  );
});

test("the space-separated spelling the sibling scripts use is accepted", () => {
  const box = workspace();

  const ran = guard(box, ["--dir", box.lane, "--branch", "devloop/zz-aaa1"]);

  assert.equal(ran.code, 0, `the guard refused --dir <value>:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the command it was given");
});

test("no command after the separator is a refusal, not a silent success", () => {
  const box = workspace();
  const run = spawnSync("bash", [GUARD, `--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], {
    cwd: box.root,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });

  const ran = { code: run.status, out: run.stdout ?? "", err: run.stderr ?? "", ran: existsSync(box.marker) };

  refused(ran, "a guard call with nothing to guard");
  assert.match(
    ran.err,
    /no command after/,
    `the refusal does not say that nothing was handed to the guard, so this test would pass on ` +
      `any other refusal firing first:\n${ran.err}`,
  );
});
