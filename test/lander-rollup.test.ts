import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };

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

function stubs(root: string, view: string, checks: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  write(
    bin,
    "gh",
    `#!/bin/bash
case "$1 $2" in
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr view")   ${view} ;;
  "pr checks") ${checks} ;;
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

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lander-rollup-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, "README.md", "first\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  git(repo, "checkout", "--quiet", "-b", "devloop/zz-aaa1");
  write(repo, "fix.txt", "the change a lane made\n");
  git(repo, "add", "fix.txt");
  git(repo, "commit", "-m", "the change a lane made");
  git(repo, "push", "--quiet", "-u", "origin", "devloop/zz-aaa1");

  git(repo, "checkout", "--quiet", "master");
  return { root, bare, repo };
}

function run(root: string, repo: string, bin: string) {
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
      "devloop/zz-aaa1",
      "--prefix",
      `landrollup-${process.pid}`,
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

test("a rollup read that fails is reported as unread, not as a red pull request", () => {
  const box = workspace();
  const bin = stubs(
    box.root,
    "echo 'HTTP 403: API rate limit exceeded for installation (https://api.github.com/graphql)' >&2; exit 1",
    "exit 0",
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(
    ran.out,
    /^red:/m,
    "a rollup that could not be read at all is reported as a failing build, which sends whoever " +
      `reads this hunting a CI failure that does not exist:\n${ran.out}`,
  );
  assert.match(
    ran.out,
    /^unreadable:/m,
    `the output does not say the rollup could not be read:\n${ran.out}`,
  );
  assert.match(
    ran.out,
    /gh pr view 101 --repo acme\/site/,
    `the output does not name the read that was attempted:\n${ran.out}`,
  );
  assert.match(ran.out, /rate limit/, `the reason the read failed is nowhere in the output:\n${ran.out}`);
  assert.equal(ran.code, 9, `an unread rollup does not have its own exit status:\n${ran.out}\n${ran.err}`);
});

test("a rollup that is not the JSON it should be is reported as unread, not as a red pull request", () => {
  const box = workspace();
  const bin = stubs(box.root, "echo 'Gateway Timeout'", "exit 0");

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^red:/m, `a rollup that did not parse is reported as red:\n${ran.out}`);
  assert.match(ran.out, /^unreadable:/m, `the output does not say the rollup could not be read:\n${ran.out}`);
  assert.equal(ran.code, 9, `a rollup that did not parse does not exit 9:\n${ran.out}\n${ran.err}`);
});

test("a check that genuinely failed is still red, named, and not merged", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    `echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"FAILURE"}],"headRefOid":"${head}"}'`,
    "exit 1",
  );

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^red:/m, `a failing check is no longer reported as red:\n${ran.out}`);
  assert.match(ran.out, /CI/, `the red report does not name the check that failed:\n${ran.out}`);
  assert.equal(ran.code, 4, `a failing check no longer exits 4:\n${ran.out}\n${ran.err}`);
});

test("a check still in flight is not ready rather than red", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    `echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":""}],"headRefOid":"${head}"}'`,
    "exit 8",
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^red:/m, `a check that has not concluded is reported as red:\n${ran.out}`);
  assert.match(ran.out, /^not_ready:/m, `a check that has not concluded is not reported as pending:\n${ran.out}`);
  assert.equal(ran.code, 7, `a pending check does not exit 7:\n${ran.out}\n${ran.err}`);
});

function rollupView(head: string, rollup: string): string {
  return `echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":${rollup},"headRefOid":"${head}"}'`;
}

test("a rollup of commit statuses that all succeeded is green and ready to merge", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    rollupView(
      head,
      '[{"__typename":"StatusContext","context":"codecov/project","state":"SUCCESS"},' +
        '{"__typename":"StatusContext","context":"vercel","state":"SUCCESS"}]',
    ),
    "exit 0",
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(
    ran.out,
    /^unreadable:/m,
    `a commit status is reported as a rollup that did not parse:\n${ran.out}`,
  );
  assert.match(ran.out, /^ready:/m, `green commit statuses are not read as ready:\n${ran.out}`);
  assert.equal(ran.code, 0, `green commit statuses do not exit 0:\n${ran.out}\n${ran.err}`);
});

test("a commit status that failed is red and names the context", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    rollupView(
      head,
      '[{"__typename":"StatusContext","context":"vercel","state":"SUCCESS"},' +
        '{"__typename":"StatusContext","context":"codecov/project","state":"FAILURE"}]',
    ),
    "exit 1",
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^not_ready:/m, `a failed commit status is deferred as pending:\n${ran.out}`);
  assert.match(ran.out, /^red: codecov\/project failed/m, `a failed commit status is not red, or does not name the context:\n${ran.out}`);
  assert.equal(ran.code, 4, `a failed commit status does not exit 4:\n${ran.out}\n${ran.err}`);
});

test("a commit status in error is red, not pending", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    rollupView(head, '[{"__typename":"StatusContext","context":"codecov/patch","state":"ERROR"}]'),
    "exit 1",
  );

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^red: codecov\/patch failed/m, `an errored commit status is not red:\n${ran.out}`);
  assert.equal(ran.code, 4, `an errored commit status does not exit 4:\n${ran.out}\n${ran.err}`);
});

test("a commit status still pending or expected is not ready rather than red or unreadable", () => {
  for (const state of ["PENDING", "EXPECTED"]) {
    const box = workspace();
    const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
    const bin = stubs(
      box.root,
      rollupView(head, `[{"__typename":"StatusContext","context":"codecov/project","state":"${state}"}]`),
      "exit 8",
    );

    const ran = run(box.root, box.repo, bin);

    assert.doesNotMatch(ran.out, /^red:/m, `a ${state} commit status is reported as red:\n${ran.out}`);
    assert.match(
      ran.out,
      /^not_ready: codecov\/project on 101 has not concluded/m,
      `a ${state} commit status is not reported as pending by context:\n${ran.out}`,
    );
    assert.equal(ran.code, 7, `a ${state} commit status does not exit 7:\n${ran.out}\n${ran.err}`);
  }
});

test("a rollup mixing check runs and commit statuses reads both kinds", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");

  const redStatus = stubs(
    box.root,
    rollupView(
      head,
      '[{"__typename":"CheckRun","name":"CI","conclusion":"SUCCESS","status":"COMPLETED"},' +
        '{"__typename":"StatusContext","context":"codecov/project","state":"FAILURE"}]',
    ),
    "exit 1",
  );
  const ranRed = run(box.root, box.repo, redStatus);
  assert.match(ranRed.out, /^red: codecov\/project failed/m, `a failed status beside a green check run is not red:\n${ranRed.out}`);
  assert.equal(ranRed.code, 4, ranRed.out + ranRed.err);

  const other = workspace();
  const otherHead = git(other.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const pendingRun = stubs(
    other.root,
    rollupView(
      otherHead,
      '[{"__typename":"CheckRun","name":"CI","conclusion":"","status":"IN_PROGRESS"},' +
        '{"__typename":"StatusContext","context":"codecov/project","state":"SUCCESS"}]',
    ),
    "exit 8",
  );
  const ranPending = run(other.root, other.repo, pendingRun);
  assert.match(ranPending.out, /^not_ready: CI on 101/m, `a running check run beside a green status is not pending:\n${ranPending.out}`);
  assert.equal(ranPending.code, 7, ranPending.out + ranPending.err);

  const third = workspace();
  const thirdHead = git(third.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const allGreen = stubs(
    third.root,
    rollupView(
      thirdHead,
      '[{"__typename":"CheckRun","name":"CI","conclusion":"SUCCESS","status":"COMPLETED"},' +
        '{"__typename":"StatusContext","context":"codecov/project","state":"SUCCESS"}]',
    ),
    "exit 0",
  );
  const ranGreen = run(third.root, third.repo, allGreen);
  assert.match(ranGreen.out, /^ready:/m, `a green check run beside a green status is not ready:\n${ranGreen.out}`);
  assert.equal(ranGreen.code, 0, ranGreen.out + ranGreen.err);
});
