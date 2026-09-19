import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const GUARD = join(SKILL, "git-guard.sh");

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(
    ["-c", "user.name=Guard Test", "-c", "user.email=guard@example.invalid", ...argv],
    { cwd },
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

function workspace(defaultBranch = "master"): Box {
  const root = mkdtempSync(join(tmpdir(), "git-guard-"));
  const repo = join(root, "repo");

  git(root, "init", "--quiet", `--initial-branch=${defaultBranch}`, repo);
  writeFileSync(join(repo, "README.md"), "first\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "the first commit");

  const lane = join(root, "lane");
  git(repo, "worktree", "add", "--quiet", "-b", "devloop/zz-aaa1", lane, defaultBranch);

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

function push(box: Box, args: string[], pushArgs: string[]): Ran {
  const bin = join(box.root, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "git");
  writeFileSync(
    shim,
    '#!/bin/sh\nfor a in "$@"; do [ "$a" = push ] && { touch "$GUARD_TEST_MARKER"; exit 0; }; done\n' +
      'PATH="${PATH#*:}" exec git "$@"\n',
  );
  chmodSync(shim, 0o755);
  const run = spawnSync("bash", [GUARD, ...args, "--", "git", "push", ...pushArgs], {
    cwd: box.root,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH ?? ""}`, GUARD_TEST_MARKER: box.marker },
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

function refusedRefspec(ran: Ran, refspec: string, dst: string) {
  refused(ran, `a push whose refspec ${refspec} lands on ${dst}`);
  assert.match(
    ran.err,
    /push refspec/,
    `the refusal came from some other branch of the guard, so this test would pass with the ` +
      `refspec check deleted - the branch the worktree is on says nothing about where a push ` +
      `lands, and the refspec is the only thing that does:\n${ran.err}`,
  );
  assert.match(ran.err, new RegExp(`names ${dst}`), `the refusal does not name the destination it refused:\n${ran.err}`);
}

test("a push whose refspec lands on master is refused even when --branch and HEAD agree", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "HEAD:master"]);

  refusedRefspec(ran, "HEAD:master", "master");
});

test("a push with an empty source deletes the destination, and master as that destination is refused", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", ":master"]);

  refusedRefspec(ran, ":master", "master");
});

test("a forced push to main is refused, and the leading plus does not hide the destination", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["--force", "origin", "+HEAD:main"]);

  refusedRefspec(ran, "+HEAD:main", "main");
});

test("the lane's own branch as the source does not make master an acceptable destination", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "devloop/zz-aaa1:master"]);

  refusedRefspec(ran, "devloop/zz-aaa1:master", "master");
});

test("the fully qualified spelling of master is refused like the short one", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "+HEAD:refs/heads/master"]);

  refusedRefspec(ran, "+HEAD:refs/heads/master", "refs/heads/master");
});

test("the heads/ spelling resolves to master on the remote and is refused like the others", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "HEAD:heads/master"]);

  refusedRefspec(ran, "HEAD:heads/master", "heads/master");
});

test("the heads/ spelling of main is refused as well", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "HEAD:heads/main"]);

  refusedRefspec(ran, "HEAD:heads/main", "heads/main");
});

test("a bare refspec is its own destination, so pushing master by name is refused", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "master"]);

  refusedRefspec(ran, "master", "master");
});

function refusedPattern(ran: Ran, refspec: string, why: RegExp) {
  refused(ran, `a push whose refspec ${refspec} has no single destination`);
  assert.match(
    ran.err,
    /push refspec/,
    `the refusal came from some other branch of the guard, so this test would pass with the ` +
      `refspec check deleted - the branch the worktree is on says nothing about where a push ` +
      `lands, and the refspec is the only thing that does:\n${ran.err}`,
  );
  assert.match(
    ran.err,
    why,
    `the refusal came from the named-destination check rather than from the one for a destination ` +
      `that is a pattern or empty, so this test would pass with that check deleted:\n${ran.err}`,
  );
}

test("a pattern destination matches master among the rest and is refused", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "refs/heads/*:refs/heads/*"]);

  refusedPattern(ran, "refs/heads/*:refs/heads/*", /pattern refs\/heads\/\*/);
});

test("a forced pattern destination is refused, and the leading plus does not hide the pattern", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "+refs/heads/*:refs/heads/*"]);

  refusedPattern(ran, "+refs/heads/*:refs/heads/*", /pattern refs\/heads\/\*/);
});

test("the matching refspec has no destination and pushes every shared branch, so it is refused", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", ":"]);

  refusedPattern(ran, ":", /empty destination/);
});

test("the forced matching refspec is refused as well", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "+:"]);

  refusedPattern(ran, "+:", /empty destination/);
});

test("the refspec is read with --dir alone, which is how the lander calls the guard", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`], ["origin", "HEAD:master"]);

  refusedRefspec(ran, "HEAD:master", "master");
});

test("a push to the lane's own branch still runs", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["-u", "origin", "devloop/zz-aaa1"]);

  assert.equal(ran.code, 0, `the guard refused a push to the lane's own branch:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the push it was given");
});

test("a bare --force-with-lease with no refspec still runs", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["--force-with-lease"]);

  assert.equal(ran.code, 0, `the guard refused a push with no refspec at all:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the push it was given");
});

test("the lander's lease-and-refspec push to the lane's own branch still runs with --dir alone", () => {
  const box = workspace();
  const head = git(box.lane, "rev-parse", "HEAD");

  const ran = push(
    box,
    [`--dir=${box.lane}`],
    [`--force-with-lease=refs/heads/devloop/zz-aaa1:${head}`, "origin", "HEAD:refs/heads/devloop/zz-aaa1"],
  );

  assert.equal(
    ran.code,
    0,
    `the guard refused the exact push the lander makes, so no rebased branch could ever be ` +
      `published again:\n${ran.out}\n${ran.err}`,
  );
  assert.equal(ran.ran, true, "the guard exited 0 without running the push it was given");
});

test("a push option whose value happens to be master is not read as a refspec", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["-o", "master", "origin", "devloop/zz-aaa1"]);

  assert.equal(ran.code, 0, `the guard read an option value as a refspec:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the push it was given");
});

const CONFIGURED = "blueprint-basic-master";

test("the branch named by --default is refused as --branch, from a checkout that really is on it", () => {
  const box = workspace(CONFIGURED);

  const ran = guard(box, [`--dir=${box.repo}`, `--branch=${CONFIGURED}`, `--default=${CONFIGURED}`]);

  refused(ran, `the configured default ${CONFIGURED}`);
  assert.match(
    ran.err,
    /which is a default branch/,
    `the refusal came from some other branch of the guard, so this test would pass with the ` +
      `default-branch check ignoring --default - HEAD and --branch agree here, so nothing else ` +
      `should refuse:\n${ran.err}`,
  );
  assert.match(ran.err, new RegExp(CONFIGURED), `the refusal does not say what was refused:\n${ran.err}`);
});

test("without --default a branch that is not master or main is not refused, so the flag is what carries the name", () => {
  const box = workspace(CONFIGURED);

  const ran = guard(box, [`--dir=${box.repo}`, `--branch=${CONFIGURED}`]);

  assert.equal(ran.code, 0, `the guard refused a branch nothing told it was a default:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the command it was given");
});

test("a push whose refspec lands on the configured default is refused like one landing on master", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["origin", `HEAD:${CONFIGURED}`]);

  refusedRefspec(ran, `HEAD:${CONFIGURED}`, CONFIGURED);
});

test("a forced push to the fully qualified configured default is refused", () => {
  const box = workspace(CONFIGURED);

  const ran = push(
    box,
    [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`],
    ["--force", "origin", `+HEAD:refs/heads/${CONFIGURED}`],
  );

  refusedRefspec(ran, `+HEAD:refs/heads/${CONFIGURED}`, `refs/heads/${CONFIGURED}`);
});

test("the heads/ spelling of the configured default is refused as well", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["origin", `HEAD:heads/${CONFIGURED}`]);

  refusedRefspec(ran, `HEAD:heads/${CONFIGURED}`, `heads/${CONFIGURED}`);
});

test("a bare refspec naming the configured default is refused", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["origin", CONFIGURED]);

  refusedRefspec(ran, CONFIGURED, CONFIGURED);
});

test("a push with an empty source deletes the configured default, and is refused", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["origin", `:${CONFIGURED}`]);

  refusedRefspec(ran, `:${CONFIGURED}`, CONFIGURED);
});

test("the lander's --dir-only call still refuses a refspec landing on the configured default", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, `--default=${CONFIGURED}`], ["origin", `HEAD:${CONFIGURED}`]);

  refusedRefspec(ran, `HEAD:${CONFIGURED}`, CONFIGURED);
});

test("the space-separated spelling of --default is accepted like the sibling flags", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, ["--dir", box.lane, "--branch", "devloop/zz-aaa1", "--default", CONFIGURED], ["origin", `HEAD:${CONFIGURED}`]);

  refusedRefspec(ran, `HEAD:${CONFIGURED}`, CONFIGURED);
});

test("master stays refused when the configured default is something else", () => {
  const box = workspace(CONFIGURED);

  const asBranch = guard(box, [`--dir=${box.lane}`, "--branch=master", `--default=${CONFIGURED}`]);
  refused(asBranch, "master as --branch beside another configured default");
  assert.match(asBranch.err, /--branch is master/, `the refusal does not say master was refused:\n${asBranch.err}`);

  const asRefspec = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["origin", "HEAD:master"]);
  refusedRefspec(asRefspec, "HEAD:master", "master");
});

test("main stays refused when the configured default is something else", () => {
  const box = workspace(CONFIGURED);

  const asBranch = guard(box, [`--dir=${box.lane}`, "--branch=main", `--default=${CONFIGURED}`]);
  refused(asBranch, "main as --branch beside another configured default");
  assert.match(asBranch.err, /--branch is main/, `the refusal does not say main was refused:\n${asBranch.err}`);

  const asRefspec = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["origin", "+HEAD:refs/heads/main"]);
  refusedRefspec(asRefspec, "+HEAD:refs/heads/main", "refs/heads/main");
});

test("a comma-separated --default refuses every name it carries", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=trunk,${CONFIGURED}`], ["origin", `HEAD:${CONFIGURED}`]);

  refusedRefspec(ran, `HEAD:${CONFIGURED}`, CONFIGURED);
});

test("a repeated --default refuses every name it was given", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", "--default=trunk", `--default=${CONFIGURED}`], ["origin", "HEAD:trunk"]);

  refusedRefspec(ran, "HEAD:trunk", "trunk");
});

test("a push to the lane's own branch still runs with --default given", () => {
  const box = workspace(CONFIGURED);

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1", `--default=${CONFIGURED}`], ["-u", "origin", "devloop/zz-aaa1"]);

  assert.equal(ran.code, 0, `the guard refused a push to the lane's own branch:\n${ran.out}\n${ran.err}`);
  assert.equal(ran.ran, true, "the guard exited 0 without running the push it was given");
});

test("the lander's lease-and-refspec push still runs with --default given and --dir alone", () => {
  const box = workspace(CONFIGURED);
  const head = git(box.lane, "rev-parse", "HEAD");

  const ran = push(
    box,
    [`--dir=${box.lane}`, `--default=${CONFIGURED}`],
    [`--force-with-lease=refs/heads/devloop/zz-aaa1:${head}`, "origin", "HEAD:refs/heads/devloop/zz-aaa1"],
  );

  assert.equal(
    ran.code,
    0,
    `the guard refused the exact push the lander makes once it passes the base it was handed, so no ` +
      `rebased branch could be published in a workspace that lands elsewhere:\n${ran.out}\n${ran.err}`,
  );
  assert.equal(ran.ran, true, "the guard exited 0 without running the push it was given");
});

function refusedEveryBranch(ran: Ran, flag: string) {
  refused(ran, `a push with ${flag}, which writes every local branch without naming one`);
  assert.match(
    ran.err,
    new RegExp(`push ${flag}`),
    `the refusal came from some other branch of the guard, so this test would pass with the ` +
      `${flag} check deleted - the flag carries no refspec, so none of the destination checks ` +
      `can see it, and it moves master all the same:\n${ran.err}`,
  );
}

test("git push --all carries no refspec and moves master with the rest, so it is refused", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["--all", "origin"]);

  refusedEveryBranch(ran, "--all");
});

test("git push --mirror carries no refspec and moves master with the rest, so it is refused", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["--mirror", "origin"]);

  refusedEveryBranch(ran, "--mirror");
});

test("--all after the remote is refused like --all before it", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["origin", "--all"]);

  refusedEveryBranch(ran, "--all");
});

test("--branches is the newer spelling of --all and is refused with it", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`, "--branch=devloop/zz-aaa1"], ["--branches", "origin"]);

  refusedEveryBranch(ran, "--branches");
});

test("--mirror with --dir alone is refused, which is how the lander calls the guard", () => {
  const box = workspace();

  const ran = push(box, [`--dir=${box.lane}`], ["--mirror", "origin"]);

  refusedEveryBranch(ran, "--mirror");
});
