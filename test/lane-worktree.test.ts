import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const RELEASE_LANE = join(SKILL, "release-lane.sh");

function git(cwd: string, ...argv: string[]) {
  const run = spawnGit(["-c", "user.name=Lane", "-c", "user.email=lane@example.com", ...argv], { cwd });
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "lane-worktree-"));
  const bare = join(root, "origin.git");
  const wt = join(root, "worktree");
  git(root, "init", "--quiet", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, wt);
  writeFileSync(join(wt, "README"), "one\n");
  git(wt, "add", "README");
  git(wt, "commit", "--quiet", "-m", "first");
  git(wt, "push", "--quiet", "origin", "master");
  git(wt, "checkout", "--quiet", "-b", "devloop/zz-aaa1");
  return { root, wt };
}

function held(root: string) {
  const lane = join(root, "pw-lane-4.lock");
  mkdirSync(lane);
  writeFileSync(join(root, "pw-lane-4.owner"), "zz-aaa1 slot 3 TEST_ENV_NUMBER 4\n");
  mkdirSync(join(root, "pw-slots"));
  const slot = join(root, "pw-slots", "3");
  writeFileSync(slot, "zz-aaa1\n");
  return { lane, slot };
}

function release(root: string, wt: string) {
  const box = held(root);
  const ran = spawnSync("bash", [RELEASE_LANE, "--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1", "--worktree", wt], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  const out = ran.stdout ?? "";
  const line = out.split("\n").find((l) => l.startsWith("worktree: "));
  return { code: ran.status, word: line === undefined ? "" : line.slice("worktree: ".length).trim(), out, err: ran.stderr ?? "" };
}

test("release-lane.sh reads the worktree and says gone, clean, unpushed or uncommitted", () => {
  const { root, wt } = checkout();

  const gone = release(root, join(root, "nowhere"));
  assert.equal(gone.code, 0, gone.err);
  assert.equal(gone.word, "GONE");
  assert.match(gone.out, /nowhere does not exist/);

  rmSync(join(root, "pw-lane-4.lock"), { recursive: true, force: true });
  rmSync(join(root, "pw-slots"), { recursive: true, force: true });
  const clean = release(root, wt);
  assert.equal(clean.code, 0, clean.err);
  assert.equal(clean.word, "CLEAN", clean.out);

  writeFileSync(join(wt, "README"), "two\n");
  git(wt, "commit", "--quiet", "-am", "second");
  rmSync(join(root, "pw-lane-4.lock"), { recursive: true, force: true });
  rmSync(join(root, "pw-slots"), { recursive: true, force: true });
  const unpushed = release(root, wt);
  assert.equal(unpushed.word, "UNPUSHED", unpushed.out);
  assert.match(unpushed.out, /devloop\/zz-aaa1 holds 1 commit\(s\) no remote has/);

  git(wt, "push", "--quiet", "origin", "devloop/zz-aaa1");
  rmSync(join(root, "pw-lane-4.lock"), { recursive: true, force: true });
  rmSync(join(root, "pw-slots"), { recursive: true, force: true });
  assert.equal(release(root, wt).word, "CLEAN", "a branch pushed without an upstream still read as unpushed");

  writeFileSync(join(wt, "weight_resolution.rb"), "class WeightResolution; end\n");
  rmSync(join(root, "pw-lane-4.lock"), { recursive: true, force: true });
  rmSync(join(root, "pw-slots"), { recursive: true, force: true });
  const untracked = release(root, wt);
  assert.equal(untracked.code, 0, untracked.err);
  assert.equal(untracked.word, "UNCOMMITTED", "an untracked file is exactly the work that was thrown away");
  assert.match(untracked.out, /holds 1 uncommitted change\(s\)/);
  assert.equal(existsSync(join(wt, "weight_resolution.rb")), true, "reading the worktree changed it");

  writeFileSync(join(wt, "README"), "three\n");
  git(wt, "commit", "--quiet", "-am", "third");
  rmSync(join(root, "pw-lane-4.lock"), { recursive: true, force: true });
  rmSync(join(root, "pw-slots"), { recursive: true, force: true });
  const both = release(root, wt);
  assert.equal(both.word, "UNCOMMITTED", "uncommitted work outranks unpushed commits - it is the half nothing protects");
  assert.match(both.out, /1 uncommitted change\(s\) and 1 unpushed commit\(s\)/);
});

test("a directory that is not a checkout is reported as unread rather than clean", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-worktree-"));
  const notGit = join(root, "worktree");
  mkdirSync(notGit);
  writeFileSync(join(notGit, "left-behind.rb"), "x\n");

  const ran = release(root, notGit);
  assert.equal(ran.word, "UNREAD", ran.out);
  assert.match(ran.out, /Look inside it/);
});

test("a checkout whose git read fails is reported as unread, never clean", () => {
  const { root, wt } = checkout();
  writeFileSync(join(wt, "finished.rb"), "class Finished; end\n");
  writeFileSync(join(wt, ".git", "index"), "garbage");

  const ran = release(root, wt);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.word, "UNREAD", `a failed status read looked like an empty worktree: ${ran.out}`);
  assert.match(ran.out, /Look inside it/);
  assert.equal(existsSync(join(wt, "finished.rb")), true, "reading the worktree changed it");
});

test("without --worktree the script reports the lane and the slot exactly as before", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-worktree-"));
  const box = held(root);
  const ran = spawnSync("bash", [RELEASE_LANE, "--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(/^worktree:/m.test(ran.stdout), false, "a worktree line appeared for a caller that named none");
});

const WT = mkdtempSync(join(tmpdir(), "lane-worktree-args-"));
const WORKTREE = join(WT, "zz-aaa1");

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  worktrees: WT,
  repos: { site: { path: "repo", test: "npm test", role: "node" } },
};

const TRIAGE_OK = {
  eligible: true,
  repo: "site",
  title: "a blocked run hides finished work",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

function releaseCall(calls: Call[]): Call {
  const found = calls.find((c) => c.label === "release:zz-aaa1");
  assert.ok(found, `the lane was never given back. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found;
}

function blocked(answer: Record<string, unknown> | null) {
  return runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "stopped: lane 2 was already held" };
    return answer;
  });
}

test("a run that ends blocked over a worktree holding uncommitted work says so in a top-level field and on the console", async () => {
  const { calls, logs, done } = blocked({ lane: "released", slot: "released", worktree: "uncommitted" });

  const result = await done;
  const call = releaseCall(calls);
  assert.match(call.prompt, new RegExp(`--owner 'zz-aaa1' --worktree ${WORKTREE.replace(/[/.]/g, "\\$&")}\\b`));
  assert.match(call.prompt, /export GIT_CONFIG_GLOBAL=\/dev\/null BUNDLE_USER_CONFIG=\/dev\/null && bash \S+\/release-lane\.sh/);
  assert.equal(call.prompt.includes("`"), false, "a backtick in the prompt closes its template literal early");
  assert.deepEqual((call.schema as { required: string[] }).required, ["lane", "slot", "worktree"]);

  assert.equal(result["outcome"], "blocked");
  assert.match(String(result["worktree"]), /^UNCOMMITTED - /);
  assert.ok(String(result["worktree"]).includes(WORKTREE), `the field does not name the worktree: ${result["worktree"]}`);
  assert.match(String(result["worktree"]), /uncommitted work/);

  const line = logs.find((l) => l.startsWith("BLOCKED zz-aaa1"));
  assert.ok(line, `no console line for the blocked outcome: ${logs.join(" | ")}`);
  assert.ok(line.includes(`worktree: UNCOMMITTED - ${WORKTREE}`), `the console line does not carry the worktree: ${line}`);
});

test("a run that ends blocked over a clean or absent worktree says that in the same field", async () => {
  for (const word of ["clean", "gone"]) {
    const { logs, done } = blocked({ lane: "released", slot: "released", worktree: word });
    const result = await done;
    assert.equal(result["outcome"], "blocked");
    assert.equal(result["worktree"], `${word} - ${WORKTREE}`);
    const line = logs.find((l) => l.startsWith("BLOCKED zz-aaa1"));
    assert.ok(line && line.includes(`worktree: ${word} - ${WORKTREE}`), `the console line does not carry the worktree: ${line}`);
  }
});

test("unpushed commits are reported as their own state, naming the worktree", async () => {
  const { done } = blocked({ lane: "released", slot: "released", worktree: "unpushed" });
  const result = await done;
  assert.match(String(result["worktree"]), /^UNPUSHED - /);
  assert.ok(String(result["worktree"]).includes(WORKTREE));
});

test("a release step that does not say what the worktree holds leaves the field unknown, never clean", async () => {
  for (const answer of [{ lane: "released", slot: "released" }, null]) {
    const { done } = blocked(answer);
    const result = await done;
    assert.match(String(result["worktree"]), /^UNKNOWN - /);
    assert.ok(String(result["worktree"]).includes(WORKTREE), `the field does not name the worktree: ${result["worktree"]}`);
  }
});

test("a needs_feedback and a fix agent that died carry the worktree field too", async () => {
  const feedback = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "needs_feedback", summary: "asks", question: "which shape?" };
    return { lane: "released", slot: "released", worktree: "uncommitted" };
  });
  const asked = await feedback.done;
  assert.equal(asked["outcome"], "needs_feedback");
  assert.match(String(asked["worktree"]), /^UNCOMMITTED - /);

  const died = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return null;
    return { lane: "released", slot: "released", worktree: "uncommitted" };
  });
  const dead = await died.done;
  assert.equal(dead["outcome"], "agent_error");
  assert.match(String(dead["worktree"]), /^UNCOMMITTED - /);
  const line = died.logs.find((l) => l.startsWith("AGENT DIED zz-aaa1"));
  assert.ok(line && line.includes("worktree: UNCOMMITTED"), `the console line does not carry the worktree: ${line}`);
});

test("a step that throws mid-run still reports a worktree holding work, in the log", async () => {
  const { logs, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) throw new Error("the fix agent died mid-run");
    return { lane: "released", slot: "released", worktree: "uncommitted" };
  });
  await assert.rejects(done, /died mid-run/);
  assert.ok(
    logs.some((l) => l.includes(`worktree: UNCOMMITTED - ${WORKTREE}`)),
    `a run that threw is the one whose result nobody reads, so the log has to say it: ${logs.join(" | ")}`,
  );
});

test("a verified run does not clutter its console line with a worktree the handoff removed", async () => {
  const { logs, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "pushed", summary: "fixed", prUrl: "https://example.test/pr/1" };
    if (n === 3) return { approved: true, notes: "good" };
    if (n === 4) return { status: "verified", verified: true, notes: "labelled" };
    return { lane: "already_gone", slot: "released", worktree: "gone" };
  });
  const result = await done;
  assert.equal(result["outcome"], "verified");
  assert.equal(result["worktree"], `gone - ${WORKTREE}`);
  const line = logs.find((l) => l.startsWith("READY TO LAND zz-aaa1"));
  assert.ok(line && !line.includes("worktree:"), `a clean ending reported its worktree anyway: ${line}`);
});
