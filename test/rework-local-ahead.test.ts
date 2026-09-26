import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript } from "./support/workflow.js";

const ID = "zz-ccc3";
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
  const merged: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, ...env };
  for (const name of ["GIT_EDITOR", "EDITOR", "VISUAL"]) delete merged[name];
  return spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: merged,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
}

function fixture(diverged = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pitwall-rework-local-")));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=master", origin);

  const repo = join(root, "repo");
  git(root, "clone", "--quiet", origin, repo);
  commit(repo, "shared.ts", "keep = 1\n", "Add the shared file");
  git(repo, "push", "--quiet", "origin", "master");

  const lane = join(root, "lanes", ID);
  git(repo, "worktree", "add", "--quiet", "-b", BRANCH, lane, "master");
  commit(lane, "lane.ts", "lane = 1\n", "Add the lane file");
  git(lane, "push", "--quiet", "-u", "origin", BRANCH);
  const pushedHead = git(lane, "rev-parse", "HEAD");

  if (diverged) git(lane, "reset", "--quiet", "--hard", "HEAD~1");
  commit(lane, "lane.ts", "lane = 2\n", "Give the lane file its second value");
  const localHead = git(lane, "rev-parse", "HEAD");

  commit(repo, "other.ts", "other = 1\n", "Move master on");
  git(repo, "push", "--quiet", "origin", "master");
  git(repo, "fetch", "--quiet", "origin");

  return { root, repo, lane, pushedHead, localHead, wt: join(root, `${ID}-rework`) };
}

function onlyLine(prompt: string, what: RegExp, describe: string): string {
  const named = prompt.split("\n").filter((line) => what.test(line));
  assert.equal(
    named.length,
    1,
    `the resolve brief no longer names exactly one command that ${describe} - update this test ` +
      `rather than deleting it. Found:\n${named.join("\n")}`,
  );
  return named[0]!;
}

async function resolveCall(root: string) {
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
  const { calls, done } = runScript("rework.js", args, (_call, n) =>
    n === 1 ? { status: "blocked", notes: "stopped after the brief was read" } : { lane: "released", slot: "released" },
  );
  await done;
  return calls[0]!;
}

function compares(prompt: string): string {
  return onlyLine(prompt, /^ {2}if .*\brev-list --left-right --count\b/, "compares the local ref against the remote one");
}

function takesTheLocalRef(prompt: string): string {
  return onlyLine(prompt, /^ {2}cd \S+ && git .*\bmerge --ff-only\b/, "takes the local ref into the rework worktree");
}

function bringsMasterIn(prompt: string): string {
  return onlyLine(
    prompt,
    /^ {2}cd \S+ && git .*\bmerge\b.*origin\/master$/,
    "brings master into the branch",
  );
}

test("the brief compares the local ref against origin's head and takes a lane's unpushed commit in before merging", async () => {
  const { root, repo, localHead, pushedHead, wt } = fixture();
  const call = await resolveCall(root);
  const brief = call.prompt;

  assert.ok(
    (call.schema as any)?.properties?.localBranch,
    "the resolve schema has no field for what the comparison found, so a run that never looked and " +
      "a run that found nothing ahead answer identically",
  );

  const compare = compares(brief);
  const compared = sh(compare, repo, { branch: BRANCH });
  assert.equal(compared.status, 0, `the comparison the brief names failed:\n${compared.stderr}`);
  assert.match(
    compared.stdout,
    /LOCAL_AHEAD/,
    `the comparison does not report a local ref one commit ahead of the remote:\n${compared.stdout}`,
  );
  assert.ok(compared.stdout.includes(localHead), "the comparison does not print the local sha a person would need");
  assert.ok(compared.stdout.includes(pushedHead), "the comparison does not print the remote sha a person would need");

  const nameless = sh(compare, repo, { branch: "" });
  assert.match(
    nameless.stdout,
    /NO_REMOTE_REF/,
    `a branch name that resolves to nothing is not reported as such:\n${nameless.stdout}`,
  );
  assert.doesNotMatch(
    nameless.stdout,
    /NO_LOCAL_REF/,
    "a branch name that resolves to nothing reads as nothing being only local, which is the drop " +
      "this step exists to stop wearing a word that says it looked",
  );

  const take = takesTheLocalRef(brief);
  assert.doesNotMatch(take, /--force/, `the local ref is taken in with a force: ${take}`);
  assert.ok(
    brief.indexOf(take) < brief.indexOf(bringsMasterIn(brief)),
    "the brief takes the local ref in after bringing master in, so the merge still builds on the remote head alone",
  );

  const add = onlyLine(brief, /^ {2}git worktree add\b/, "adds the rework worktree");
  const added = sh(add, repo, { branch: BRANCH });
  assert.equal(added.status, 0, `the setup command was refused:\n${added.stderr}`);
  assert.equal(git(wt, "rev-parse", "HEAD"), pushedHead, "the rework worktree did not start at origin's head of the branch");

  const took = sh(take, repo, { branch: BRANCH });
  assert.equal(took.status, 0, `the fast-forward onto the local ref was refused:\n${took.stderr}`);
  assert.equal(git(wt, "rev-parse", "HEAD"), localHead, "the worktree was not moved onto the commit the lane had only locally");

  const merged = sh(bringsMasterIn(brief), repo);
  assert.equal(merged.status, 0, `the merge the brief names failed:\n${merged.stderr}`);
  assert.equal(
    spawnGit(["merge-base", "--is-ancestor", localHead, "HEAD"], { cwd: wt }).status,
    0,
    "the merged head does not contain the commit the lane left only in its local branch - that is " +
      "the drop this test exists for: the commit vanishes from the pull request, the lander " +
      "squashes what it can see, and nothing errors",
  );
  assert.match(git(wt, "show", "HEAD:lane.ts"), /lane = 2/, "the merged tree carries the superseded version of the file the lane last changed");

  const push = onlyLine(brief, /^ {2}cd \S+ && git push\b/, "pushes the branch").replace(/<the branch>/g, BRANCH);
  assert.doesNotMatch(push, /--force/, `the push is forced: ${push}`);
  const pushed = sh(push, repo);
  assert.equal(pushed.status, 0, `the one push the brief names was refused, so the commit it brought in stays unpublished:\n${pushed.stderr}`);
  git(repo, "fetch", "--quiet", "origin");
  assert.equal(
    spawnGit(["merge-base", "--is-ancestor", localHead, `refs/remotes/origin/${BRANCH}`], { cwd: repo }).status,
    0,
    "origin's head of the branch does not contain the commit the lane had only locally, so the pull request is still missing it",
  );
});

test("a local ref that has diverged from origin's head stops the rework instead of merging over it", async () => {
  const { root, repo, localHead, pushedHead, wt } = fixture(true);
  const brief = (await resolveCall(root)).prompt;

  const compared = sh(compares(brief), repo, { branch: BRANCH });
  assert.equal(compared.status, 0, `the comparison the brief names failed:\n${compared.stderr}`);
  assert.match(compared.stdout, /DIVERGED/, `the comparison does not report a diverged local ref:\n${compared.stdout}`);
  assert.doesNotMatch(compared.stdout, /LOCAL_AHEAD|LOCAL_BEHIND|EQUAL/, `the comparison reports a diverged ref as something else as well:\n${compared.stdout}`);

  const diverged = brief.slice(brief.indexOf("DIVERGED"));
  assert.match(diverged, /\bblocked\b/, "the brief does not tell a run with a diverged local ref to report blocked");
  const differing = onlyLine(brief, /^ {2}git -C \S+ diff --name-only\b/, "names the files that differ between the two refs");
  const listed = sh(differing, repo, { branch: BRANCH });
  assert.equal(listed.status, 0, `the command that names the differing files failed:\n${listed.stderr}`);
  assert.equal(listed.stdout.trim(), "lane.ts", `the differing file was not named:\n${listed.stdout}`);

  const add = onlyLine(brief, /^ {2}git worktree add\b/, "adds the rework worktree");
  assert.equal(sh(add, repo, { branch: BRANCH }).status, 0, "the setup command was refused");
  const took = sh(takesTheLocalRef(brief), repo, { branch: BRANCH });
  assert.notEqual(took.status, 0, "the fast-forward onto a diverged local ref succeeded, so a run that ignored the word above would silently take one side");
  assert.equal(git(wt, "rev-parse", "HEAD"), pushedHead, "the worktree moved off origin's head of the branch");
  assert.notEqual(localHead, pushedHead, "the fixture did not diverge, so nothing here is testing a diverged ref");
});

test("a resolve step that reports a diverged local ref is handed back however it reports its own status", async () => {
  const { root, localHead, pushedHead } = fixture(true);
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
  const { calls, done } = runScript("rework.js", args, (_call, n) =>
    n === 1
      ? { status: "resolved", branch: BRANCH, localBranch: "diverged", localHead, oldHead: pushedHead, newHead: "f".repeat(40), files: ["lane.ts"] }
      : { lane: "released", slot: "released" },
  );
  const result = await done;
  assert.equal(
    result.outcome,
    "blocked",
    "a rework that found the two refs diverged was carried on to the handoff, which labels the " +
      "pull request and lets the lander squash whichever side the merge happened to take",
  );
  assert.ok(String(result.notes).includes(localHead), "the result does not name the local sha, so a person cannot see what was not published");
  assert.ok(String(result.notes).includes(pushedHead), "the result does not name the remote sha");
  assert.equal(
    calls.filter((call) => call.label.startsWith("handoff:")).length,
    0,
    "the handoff step ran on a diverged branch",
  );
});

test("a resolve step that reports no comparison at all says so in the result", async () => {
  const { root } = fixture();
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
  const { done } = runScript("rework.js", args, (_call, n) => {
    if (n === 1) return { status: "resolved", branch: BRANCH, oldHead: "a".repeat(40), newHead: "b".repeat(40), files: ["shared.ts"] };
    if (n === 2) return { status: "verified", ciConclusion: "SUCCESS" };
    return { lane: "released", slot: "released" };
  });
  const result = await done;
  assert.equal(
    result.localBranch,
    "not_reported",
    "a rework that never said what the local ref held reads exactly like one that found nothing " +
      "ahead of the remote, which is the half of this defect that hides the other half",
  );
});
