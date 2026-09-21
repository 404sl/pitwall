import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const ID = "zz-aaa1";
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

function withoutAnEditor(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
  for (const name of ["GIT_EDITOR", "EDITOR", "VISUAL"]) delete env[name];
  return env;
}

function sh(command: string) {
  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: withoutAnEditor(),
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
}

function fixture(masterMoves = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pitwall-rework-merge-")));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=master", origin);

  const repo = join(root, "repo");
  git(root, "clone", "--quiet", origin, repo);
  commit(repo, "shared.ts", "keep = 1\n", "Add the shared file");
  git(repo, "push", "--quiet", "origin", "master");

  git(repo, "checkout", "--quiet", "-b", BRANCH);
  commit(repo, "shared.ts", "keep = 3\n", "Change the shared file on the branch");
  git(repo, "push", "--quiet", "-u", "origin", BRANCH);
  const branchHead = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "--quiet", "master");
  if (masterMoves) {
    commit(repo, "shared.ts", "keep = 2\n", "Change the shared file on master");
    git(repo, "push", "--quiet", "origin", "master");
  }
  git(repo, "fetch", "--quiet", "origin");

  const wt = join(root, `${ID}-rework`);
  git(repo, "worktree", "add", "--quiet", "--detach", wt, `origin/${BRANCH}`);

  return { root, repo, wt, branchHead };
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

async function resolveBrief(worktrees: string): Promise<string> {
  const args = {
    id: ID,
    pr: 739,
    repo: "site",
    slot: 3,
    root: "/root",
    skillDir: SKILL,
    lockPrefix: "pw",
    worktrees,
    repos: { site: { slug: "acme/site", path: "repo", test: "npm test" } },
  };
  const { calls, done } = runScript("rework.js", args, (_call, n) =>
    n === 1 ? { status: "blocked", notes: "stopped after the brief was read" } : { lane: "released", slot: "released" },
  );
  await done;
  return calls[0]!.prompt;
}

function bringsMasterIn(prompt: string): string {
  return onlyLine(
    prompt,
    /^ {2}cd \S+ && git .*\b(merge|rebase|cherry-pick)\b.*origin\/master$/,
    "brings master into the branch",
  );
}

function finishesTheMerge(prompt: string): string {
  return onlyLine(prompt, /^ {2}cd \S+ && git .*\bmerge --continue$/, "finishes a stopped merge");
}

function checksBeforeThePush(prompt: string): string {
  return onlyLine(prompt, /^ {2}bash \S+lane-handoff\.sh .*--pre-push\b/, "reads the messages back before the push");
}

function pushes(prompt: string): string {
  return onlyLine(prompt, /^ {2}cd \S+ && git push\b/, "pushes the branch");
}

test("the brief merges master into the branch and pushes it without rewriting anything", async () => {
  const { root, repo, wt, branchHead } = fixture();
  const brief = await resolveBrief(root);

  const brought = bringsMasterIn(brief);
  assert.match(brought, /\bgit .*\bmerge\b/, `the brief rebases instead of merging: ${brought}`);
  assert.equal(
    brief.split("\n").some((line) => /^ {2}.*\bgit .*\brebase\b/.test(line)),
    false,
    "the brief still tells the lane to rebase somewhere. A rebase rewrites the branch, and the " +
      "only push that publishes a rewritten branch is a force-push, which the session refuses - " +
      "so every rework ended on a person's board with a one-line command",
  );
  assert.equal(brief.includes("--force-with-lease"), false, "the brief still renders a lease, which is a force-push by another name");
  assert.equal(brief.includes("--rebased"), false, "the brief still tells the pre-push check the range was rebased");

  const merged = sh(brought);
  assert.notEqual(merged.status, 0, "the fixture did not conflict, so nothing here is testing a resolution");
  assert.equal(
    spawnGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt }).status,
    0,
    "the command the brief names left no merge in progress",
  );

  writeFileSync(join(wt, "shared.ts"), "keep = 2\nlockToken = 1\n");
  git(wt, "add", "-A");
  const continued = sh(finishesTheMerge(brief));
  assert.equal(
    continued.status,
    0,
    "the command the brief names to finish the merge did not succeed, and the branch is left " +
      "mid-merge. A lane has no terminal and no home config, so --continue has no core.editor to " +
      "open the merge message with and falls back to vi, which then either dies on the terminal " +
      `it cannot read or sits there until this timeout:\n${continued.error ?? ""}${continued.stderr ?? ""}`,
  );
  assert.match(
    git(wt, "log", "-1", "--format=%s"),
    /^Merge remote-tracking branch 'origin\/master'/,
    "the merge commit does not carry git's own message - the brief says there is nothing for the lane to write",
  );
  assert.equal(git(wt, "log", "-1", "--format=%an <%ae>"), "Pat Lane <pat@example.com>", "the merge commit was not written under the identity on the command");

  assert.equal(spawnGit(["merge-base", "--is-ancestor", "origin/master", "HEAD"], { cwd: wt }).status, 0, "HEAD does not contain origin/master after the merge");
  assert.equal(git(wt, "rev-list", "--count", "HEAD..origin/master"), "0", "the branch still reads as behind master");
  assert.equal(git(wt, "merge-base", "--is-ancestor", branchHead, "HEAD"), "", "the merge rewrote the head the remote holds");

  const check = checksBeforeThePush(brief).replace(/<the branch>/g, BRANCH);
  assert.match(check, /--branch devloop\/zz-aaa1/, "the pre-push check is not told which branch to ask the remote about, and HEAD is detached");
  const checked = sh(check);
  assert.equal(
    checked.status,
    0,
    "lane-handoff.sh --pre-push refuses the merged branch as the brief renders the call, so the lane " +
      `never reaches the push:\n${checked.stdout}${checked.stderr}`,
  );

  const pushLine = pushes(brief);
  assert.doesNotMatch(pushLine, /--force/, `the push is forced: ${pushLine}`);
  assert.match(pushLine, /origin HEAD:refs\/heads\/<the branch>$/, "both ends of the push are not named in full, and HEAD is detached");
  const push = pushLine.replace(/<the branch>/g, BRANCH);
  const pushed = sh(push);
  assert.equal(pushed.status, 0, `the plain push the brief names was refused:\n${pushed.stderr}`);

  git(repo, "fetch", "--quiet", "origin");
  assert.equal(git(repo, "rev-parse", `origin/${BRANCH}`), git(wt, "rev-parse", "HEAD"), "origin does not hold the merged head");
  assert.equal(
    git(repo, "rev-list", "--count", `origin/${BRANCH}..origin/master`),
    "0",
    "land-one.sh counts the branch as behind master after the push, so it would take its rebase " +
      "path - or refuse the branch as merge-shaped - instead of landing it as it stands",
  );
  assert.match(readFileSync(join(wt, "shared.ts"), "utf8"), /lockToken = 1/, "the resolution line did not survive");
});

test("a branch that already sits on master is left where it is, with nothing to push", async () => {
  const { root, wt, branchHead } = fixture(false);
  const brief = await resolveBrief(root);

  const merged = sh(bringsMasterIn(brief));
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /Already up to date/, "the merge of a head the branch already contains was not a no-op");
  assert.equal(git(wt, "rev-parse", "HEAD"), branchHead, "the head moved, so the lane would push a change that is not there");
});
