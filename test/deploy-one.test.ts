import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const DEPLOY_ONE = join(
  import.meta.dirname,
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "deploy-one.sh",
);

function git(cwd: string, ...argv: string[]) {
  const run = spawnSync(
    "git",
    ["-c", "user.name=Lander", "-c", "user.email=lander@example.com", ...argv],
    { cwd, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function commit(dir: string, host: string, message: string) {
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "deploy.rb"), `HOST=${host}\n`);
  git(dir, "add", "config/deploy.rb");
  git(dir, "commit", "-m", message);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "deploy-one-test-"));
  const bare = join(root, "origin.git");
  const shared = join(root, "shared");
  const other = join(root, "other");
  const out = join(root, "out");
  mkdirSync(out);

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, shared);
  commit(shared, "old", "first configuration");
  git(shared, "push", "--quiet", "origin", "master");

  git(root, "clone", "--quiet", bare, other);
  commit(other, "new", "move the lander to a new host");
  git(other, "push", "--quiet", "origin", "master");

  git(shared, "checkout", "--quiet", "-b", "somebody-elses-branch");
  commit(shared, "branch", "configuration that only exists on a branch");

  return { root, bare, shared, out, masterSha: git(other, "rev-parse", "HEAD") };
}

function deployOne(opts: {
  shared: string;
  deploy: string;
  revision: string;
  expect?: string;
}) {
  const argv = [
    DEPLOY_ONE,
    "--label",
    "staging",
    "--repo-path",
    opts.shared,
    "--deploy",
    opts.deploy,
    "--revision",
    opts.revision,
    "--timeout",
    "60",
  ];
  if (opts.expect) argv.push("--expect", opts.expect);
  const run = spawnSync("bash", argv, { encoding: "utf8" });
  return { code: run.status, out: run.stdout || "", err: run.stderr || "" };
}

test("deploy-one.sh runs the deploy against master's configuration, not the shared checkout's", () => {
  const { bare, shared, out, masterSha } = workspace();

  const run = deployOne({
    shared,
    deploy: `cat config/deploy.rb > ${out}/seen; pwd > ${out}/cwd`,
    revision: `git -C ${bare} rev-parse master`,
  });

  assert.equal(run.code, 0, `expected success, got ${run.code}:\n${run.out}${run.err}`);
  assert.match(run.out, /OK staging/, run.out);
  assert.equal(
    readFileSync(join(out, "seen"), "utf8"),
    "HOST=new\n",
    "the deploy read configuration from the shared checkout rather than from origin/master - " +
      "a deploy that ships the right code with the wrong host, user or branch and reports success",
  );
  assert.notEqual(
    readFileSync(join(out, "cwd"), "utf8").trim(),
    git(shared, "rev-parse", "--show-toplevel"),
    "the deploy ran in the shared checkout itself",
  );
});

test("deploy-one.sh leaves the shared checkout on its own branch and commit", () => {
  const { bare, shared, out } = workspace();
  const headBefore = git(shared, "rev-parse", "HEAD");

  deployOne({
    shared,
    deploy: `cat config/deploy.rb > ${out}/seen`,
    revision: `git -C ${bare} rev-parse master`,
  });

  assert.equal(git(shared, "rev-parse", "--abbrev-ref", "HEAD"), "somebody-elses-branch");
  assert.equal(git(shared, "rev-parse", "HEAD"), headBefore);
  assert.equal(
    readFileSync(join(shared, "config", "deploy.rb"), "utf8"),
    "HOST=branch\n",
    "the shared checkout's working tree was changed - it was pulled, checked out or reset",
  );
  assert.equal(git(shared, "status", "--porcelain"), "");
});

test("deploy-one.sh removes the worktree it cut, whatever the deploy did", () => {
  const { bare, shared, out } = workspace();

  const ok = deployOne({
    shared,
    deploy: `pwd > ${out}/cwd`,
    revision: `git -C ${bare} rev-parse master`,
  });
  assert.equal(ok.code, 0);
  assert.equal(
    git(shared, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
    "a worktree was left behind after a deploy that succeeded",
  );

  const failed = deployOne({
    shared,
    deploy: "exit 1",
    revision: "echo 0000000000000000000000000000000000000000",
  });
  assert.equal(failed.code, 1, failed.out);
  assert.equal(
    git(shared, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
    "a worktree was left behind after a deploy that failed",
  );
});

test("deploy-one.sh still decides the outcome by reading the server", () => {
  const { bare, shared } = workspace();

  const mismatch = deployOne({
    shared,
    deploy: "true",
    revision: "echo 1111111111111111111111111111111111111111",
  });
  assert.equal(mismatch.code, 1, mismatch.out);
  assert.match(mismatch.out, /FAILED staging/, mismatch.out);

  const finishedAnyway = deployOne({
    shared,
    deploy: "exit 3",
    revision: `git -C ${bare} rev-parse master`,
  });
  assert.equal(finishedAnyway.code, 0, finishedAnyway.out);
  assert.match(finishedAnyway.out, /OK staging/, finishedAnyway.out);
});

test("deploy-one.sh compares against the sha it was given, not the one it cut from", () => {
  const { bare, shared, masterSha } = workspace();

  const run = deployOne({
    shared,
    deploy: "true",
    revision: `git -C ${bare} rev-parse master`,
    expect: masterSha,
  });

  assert.equal(run.code, 0, run.out);
  assert.match(run.out, new RegExp(`expecting ${masterSha.slice(0, 8)}`), run.out);
});

test("deploy-one.sh refuses to deploy when it cannot fetch origin", () => {
  const { shared, bare } = workspace();
  git(shared, "remote", "set-url", "origin", join(bare, "..", "no-such-origin.git"));

  const run = deployOne({
    shared,
    deploy: "true",
    revision: "echo 0000000000000000000000000000000000000000",
  });

  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /cannot fetch origin\/master/, run.out);
});
