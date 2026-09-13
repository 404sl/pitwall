import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript } from "./support/workflow.js";

const ID = "zz-bbb2";
const BRANCH = `devloop/${ID}`;
const WHO = ["-c", "user.name=Pat Lane", "-c", "user.email=pat@example.com"];

function git(cwd: string, ...args: string[]): string {
  const ran = spawnGit([...WHO, ...args], { cwd });
  assert.equal(ran.status, 0, `git ${args.join(" ")}\n${ran.stderr}`);
  return ran.stdout.trim();
}

function commit(dir: string, name: string, body: string, message: string): void {
  writeFileSync(join(dir, name), body);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
}

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, ...env },
  });
}

function worktrees(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice(9));
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pitwall-rework-held-")));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=master", origin);

  const repo = join(root, "repo");
  git(root, "clone", "--quiet", origin, repo);
  commit(repo, "shared.ts", "keep = 1\n", "Add the shared file");
  git(repo, "push", "--quiet", "origin", "master");

  const lane = join(root, "lanes", ID);
  git(repo, "worktree", "add", "--quiet", "-b", BRANCH, lane, "master");
  commit(lane, "lane.ts", "lane = 1\n", "Work on the lane file");
  git(lane, "push", "--quiet", "-u", "origin", BRANCH);
  const laneHead = git(lane, "rev-parse", "HEAD");

  commit(repo, "other.ts", "other = 1\n", "Move master on");
  git(repo, "push", "--quiet", "origin", "master");
  git(repo, "fetch", "--quiet", "origin");

  return { root, origin, repo, lane, laneHead, rework: join(root, `${ID}-rework`) };
}

async function briefs(root: string) {
  const args = {
    id: ID,
    pr: 739,
    repo: "site",
    slot: 3,
    root,
    skillDir: "/skill",
    lockPrefix: "pw",
    worktrees: root,
    repos: { site: { slug: "acme/site", path: "repo", test: "npm test" } },
  };
  const { calls, done } = runScript("rework.js", args, (_call, n) => {
    if (n === 1) return { status: "resolved", branch: BRANCH, oldHead: "1".repeat(40), newHead: "2".repeat(40) };
    if (n === 2) return { status: "verified", ciConclusion: "SUCCESS" };
    return { lane: "released", slot: "released" };
  });
  await done;
  assert.ok(calls.length >= 2, "the handoff step never ran, so its brief cannot be checked");
  return { resolve: calls[0]!.prompt, handoff: calls[1]!.prompt };
}

function onlyLine(prompt: string, what: RegExp, describe: string): string {
  const named = prompt.split("\n").filter((line) => what.test(line));
  assert.equal(
    named.length,
    1,
    `the brief no longer names exactly one command that ${describe} - update this test rather ` +
      `than deleting it. Found:\n${named.join("\n")}`,
  );
  return named[0]!;
}

test("the rework takes its worktree while the lane's worktree still holds the branch", async () => {
  const { root, repo, lane, laneHead, rework } = fixture();
  const { resolve } = await briefs(root);

  const add = onlyLine(resolve, /^ {2}git worktree add\b/, "adds the rework worktree");
  assert.doesNotMatch(
    add,
    /(^|\s)-B(\s|$)/,
    "the setup step checks the branch out with -B, and git refuses to check one branch out in two " +
      "worktrees - the task lane's worktree still holds it whenever that lane ended without handing " +
      "off, and the rework then improvises. Take it detached.",
  );

  const added = sh(add, repo, { branch: BRANCH });
  assert.equal(
    added.status,
    0,
    `the setup command is refused while a second worktree holds ${BRANCH}:\n${added.stderr}`,
  );
  assert.ok(existsSync(rework), `the setup command created no worktree at ${rework}`);
  assert.notEqual(
    spawnGit(["symbolic-ref", "-q", "HEAD"], { cwd: rework }).status,
    0,
    "the rework worktree has a branch checked out - it must be detached, or the lane's worktree " +
      "and this one contend for the same ref",
  );
  assert.equal(git(rework, "rev-parse", "HEAD"), laneHead, "the rework worktree did not start at origin's head of the branch");
  assert.equal(git(lane, "rev-parse", "HEAD"), laneHead, "setting up the rework moved the lane's worktree");

  assert.match(
    resolve,
    /superseded/i,
    "the resolve brief no longer names the superseded-ref trap, so a lane that finds the task " +
      "lane's worktree holding the branch has nothing telling it not to rebase and push from there",
  );

  const rebased = spawnGit([...WHO, "rebase", "origin/master"], { cwd: rework });
  assert.equal(rebased.status, 0, rebased.stderr);
  const newHead = git(rework, "rev-parse", "HEAD");
  assert.notEqual(newHead, laneHead, "the fixture's rebase replayed nothing, so the push below proves nothing");

  const pushLine = onlyLine(resolve, /^ {2}cd \S+ && git push\b/, "pushes the rebased head");
  const push = pushLine.replace(/<the branch>/g, BRANCH).replace(/<the head you recorded>/g, laneHead);
  assert.notEqual(push, pushLine, "the push line no longer carries the placeholders this test fills in");
  const pushed = sh(push, repo);
  assert.equal(
    pushed.status,
    0,
    "the push is refused from the detached worktree - a bare 'origin HEAD' has no branch to name " +
      `its destination, so both ends must be spelled out:\n${pushed.stderr}`,
  );
  assert.equal(
    git(repo, "rev-parse", `refs/remotes/origin/${BRANCH}`),
    newHead,
    "origin's head of the branch is not the rebased head, so the push went somewhere else",
  );
  assert.equal(git(lane, "rev-parse", "HEAD"), laneHead, "the push moved the lane's worktree");
});

test("the handoff removes the lane's worktree holding the branch only once the label is on", async () => {
  const { root, repo, lane, rework } = fixture();
  git(repo, "worktree", "add", "--quiet", "--detach", rework, `origin/${BRANCH}`);
  const { handoff } = await briefs(root);

  const removal = onlyLine(handoff, /^ {2}cd \S+ && .*git worktree remove\b/, "removes the lane's worktree");
  assert.match(removal, /branch refs\/heads\//, "the removal does not match the worktree by its branch line");
  assert.ok(!removal.includes(lane), "the removal names the lane's path instead of asking git which worktree holds the branch");

  const script = handoff.indexOf("lane-handoff.sh --repo-path");
  const gate = handoff.indexOf("exited 0 or 5");
  const command = handoff.indexOf(removal);
  assert.ok(script !== -1 && gate !== -1 && command !== -1, "the handoff brief lost the script, its exit gate, or the removal");
  assert.ok(
    script < gate && gate < command,
    "the removal is not gated on lane-handoff.sh having labelled the pull request. Until the " +
      "label is on, the lane's worktree is the only copy of its state a person can inspect",
  );

  const before = worktrees(repo);
  assert.ok(before.includes(lane) && before.includes(rework), `fixture: expected both worktrees listed, got ${before.join(", ")}`);

  const ran = sh(removal, root);
  assert.equal(ran.status, 0, `the removal command failed:\n${ran.stderr}`);
  assert.match(ran.stdout, /^REMOVED: /m, `the removal did not report removing anything:\n${ran.stdout}`);

  const after = worktrees(repo);
  assert.ok(!after.includes(lane), "the lane's worktree still holds the branch after the removal");
  assert.ok(!existsSync(lane), "the lane's worktree directory was left behind");
  assert.ok(after.includes(rework), "the removal took the rework's own detached worktree - that is lane-handoff.sh's job, and matching it here means the match was not by branch");
  assert.equal(after[0], repo, "the removal touched the main checkout");
  assert.equal(git(repo, "branch", "--show-current"), "master", "the main checkout is no longer on master");

  const again = sh(removal, root);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^NO_HOLDER: /m, `a second run with nothing holding the branch did not say so:\n${again.stdout}`);
});

test("the removal refuses the main checkout when it is the one holding the branch", async () => {
  const { root, repo, lane, laneHead } = fixture();
  git(repo, "worktree", "remove", "--force", lane);
  git(repo, "checkout", "--quiet", BRANCH);
  const { handoff } = await briefs(root);
  const removal = onlyLine(handoff, /^ {2}cd \S+ && .*git worktree remove\b/, "removes the lane's worktree");

  const ran = sh(removal, root);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^REFUSED: /m, `the removal did not refuse the main checkout:\n${ran.stdout}`);
  assert.ok(existsSync(join(repo, "shared.ts")), "the main checkout is gone");
  assert.equal(git(repo, "rev-parse", "HEAD"), laneHead, "the main checkout was moved");
});
