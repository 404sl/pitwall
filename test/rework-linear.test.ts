import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript } from "./support/workflow.js";

const ID = "zz-aaa1";
const WHO = ["-c", "user.name=Pat Lane", "-c", "user.email=pat@example.com"];

function git(cwd: string, ...args: string[]): void {
  const ran = spawnGit(args, { cwd });
  assert.equal(ran.status, 0, `git ${args.join(" ")}\n${ran.stderr}`);
}

function write(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, ...WHO, "commit", "--quiet", "-m", message);
}

function identify(dir: string): void {
  git(dir, "config", "user.name", "Pat Lane");
  git(dir, "config", "user.email", "pat@example.com");
}

function fixture(): { root: string; wt: string; seed: string } {
  const root = mkdtempSync(join(tmpdir(), "pitwall-rework-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=master", origin);

  const seed = join(root, "seed");
  git(root, "clone", "--quiet", origin, seed);
  identify(seed);
  write(seed, "shared.ts", "keep = 1\n");
  commit(seed, "Add the shared file");
  git(seed, "push", "--quiet", "origin", "master");

  const wt = join(root, `${ID}-rework`);
  git(root, "clone", "--quiet", origin, wt);
  identify(wt);
  git(wt, "checkout", "--quiet", "-b", `devloop/${ID}`);
  write(wt, "shared.ts", "keep = 3\n");
  commit(wt, "Change the shared file on the branch");

  write(seed, "shared.ts", "keep = 2\n");
  commit(seed, "Change the shared file on master");
  git(seed, "push", "--quiet", "origin", "master");
  git(wt, "fetch", "--quiet", "origin");

  return { root, wt, seed };
}

function withoutAnEditor(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
  for (const name of ["GIT_EDITOR", "EDITOR", "VISUAL"]) delete env[name];
  return env;
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
    skillDir: "/skill",
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

function finishesTheRebase(prompt: string): string {
  return onlyLine(prompt, /^ {2}cd \S+ && git .*\brebase --continue$/, "finishes a stopped rebase");
}

test("the brief brings master in without leaving a merge commit the lander's rebase would drop", async () => {
  const { root, wt, seed } = fixture();
  const brief = await resolveBrief(root);

  const brought = spawnSync("bash", ["-c", bringsMasterIn(brief)], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  assert.notEqual(
    brought.status,
    0,
    "the fixture did not conflict, so nothing here is testing a resolution",
  );

  write(wt, "shared.ts", "keep = 2\nlockToken = 1\n");
  git(wt, "add", "-A");
  if (spawnGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt }).status === 0) {
    git(wt, ...WHO, "commit", "--quiet", "-m", "Resolve the shared file");
  } else {
    const stopped = ["rebase-merge", "rebase-apply"].some((dir) => existsSync(join(wt, ".git", dir)));
    assert.ok(stopped, "the command the brief names left neither a merge nor a rebase in progress");

    const continued = spawnSync("bash", ["-c", finishesTheRebase(brief)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: withoutAnEditor(),
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    assert.equal(
      continued.status,
      0,
      "the command the brief names to finish the rebase did not succeed, and the branch is left " +
        "mid-rebase. A lane has no terminal and no home config, so --continue has no core.editor " +
        "to open the replayed message with and falls back to vi, which then either dies on the " +
        `terminal it cannot read or sits there until this timeout:\n${continued.error ?? ""}${continued.stderr ?? ""}`,
    );
    assert.equal(
      spawnGit(["log", "-1", "--format=%s"], { cwd: wt }).stdout.trim(),
      "Change the shared file on the branch",
      "the replayed commit no longer carries its own message. The brief tells the lane it composes " +
        "no message here, so finishing the rebase must not be done by writing one",
    );
  }

  const merges = spawnGit(["rev-list", "--merges", "origin/master..HEAD"], { cwd: wt });
  assert.equal(merges.status, 0, merges.stderr);
  assert.equal(
    merges.stdout.trim(),
    "",
    "the branch carries a merge commit. land-one.sh rebases every branch it lands, a rebase replays " +
      "the branch's own commits, and a resolution that exists only inside a merge commit is not one " +
      "of them - so it is dropped, the rebase exits non-zero, and the lander retires the issue " +
      "instead of deferring it.",
  );

  write(seed, "other.ts", "unrelated = 1\n");
  commit(seed, "Add an unrelated file on master");
  git(seed, "push", "--quiet", "origin", "master");
  git(wt, "fetch", "--quiet", "origin");

  const landed = spawnGit([...WHO, "rebase", "origin/master"], { cwd: wt });
  assert.equal(landed.status, 0, `the rebase the lander runs did not survive:\n${landed.stderr}`);
  assert.match(
    readFileSync(join(wt, "shared.ts"), "utf8"),
    /lockToken = 1/,
    "the resolution line did not survive the rebase the lander runs, so the work is lost on the way " +
      "to master",
  );
});
