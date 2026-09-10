import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const RELEASE_LANE = join(SKILL, "release-lane.sh");

interface Released {
  code: number | null;
  lane: string;
  slot: string;
  out: string;
  err: string;
}

function release(args: string[]): Released {
  const ran = spawnSync("bash", [RELEASE_LANE, ...args], { encoding: "utf8" });
  const out = ran.stdout ?? "";
  const word = (label: string) => {
    const line = out.split("\n").find((l) => l.startsWith(`${label}: `));
    return line === undefined ? "" : line.slice(label.length + 2).trim();
  };
  return { code: ran.status, lane: word("lane"), slot: word("slot"), out, err: ran.stderr ?? "" };
}

interface Held {
  lane: string;
  owner: string;
  slot: string;
}

function held(owner: string | null, claim: string | null = owner): Held {
  const dir = mkdtempSync(join(tmpdir(), "lane-lock-"));
  const lane = join(dir, "pw-lane-4.lock");
  mkdirSync(lane);
  const ownerFile = join(dir, "pw-lane-4.owner");
  if (owner !== null) writeFileSync(ownerFile, `${owner} slot 3 TEST_ENV_NUMBER 4\n`);
  mkdirSync(join(dir, "pw-slots"));
  const slot = join(dir, "pw-slots", "3");
  if (claim !== null) writeFileSync(slot, `${claim}\n`);
  return { lane, owner: ownerFile, slot };
}

test("a lane whose owner file names this run is given back, with its owner file and its slot", () => {
  const box = held("zz-aaa1");

  const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.lane, "RELEASED");
  assert.equal(ran.slot, "RELEASED");
  assert.equal(existsSync(box.lane), false, "the lane lock is still held");
  assert.equal(existsSync(box.owner), false, "the owner file was left beside a lock that is gone");
  assert.equal(existsSync(box.slot), false, "the slot is still reserved");
});

test("a lane another run owns is left exactly as it was", () => {
  const box = held("zz-bbb2");

  const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.lane, "NOT_MINE");
  assert.equal(ran.slot, "NOT_MINE");
  assert.equal(existsSync(box.lane), true, "another run's lane lock was removed");
  assert.equal(existsSync(box.slot), true, "another run's slot reservation was removed");
  assert.match(ran.out, /zz-bbb2/, "the answer does not say who holds it");
});

test("a lock with no owner file beside it is left standing rather than guessed at", () => {
  const box = held(null, "zz-aaa1");

  const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.lane, "NOT_MINE");
  assert.equal(existsSync(box.lane), true, "a lock that proves nothing was removed anyway");
  assert.equal(ran.slot, "RELEASED", "the slot proves itself and is independent of the lock");
});

test("a lane a handoff already dropped reads already_gone and takes the stale owner file with it", () => {
  const box = held("zz-aaa1");
  spawnSync("rmdir", [box.lane]);

  const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.lane, "ALREADY_GONE");
  assert.equal(existsSync(box.owner), false, "the owner file outlived the lock it described");
});

test("an id that cannot be a lane's own removes nothing", () => {
  for (const owner of ["", "zz'aaa1", "zz aaa1"]) {
    const box = held("zz-aaa1");

    const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", owner]);

    assert.equal(ran.code, 2, `[${owner}] was accepted as an id`);
    assert.equal(ran.out, "", `[${owner}] reported an outcome on stdout`);
    assert.match(ran.err, /REFUSED/);
    assert.equal(existsSync(box.lane), true, `[${owner}] removed a lane lock it could not prove`);
    assert.equal(existsSync(box.slot), true, `[${owner}] removed a slot it could not prove`);
  }
});

test("a regular file at the lane lock path is reported as a fault, not as a lane that is busy", () => {
  const box = held("zz-aaa1");
  spawnSync("rmdir", [box.lane]);
  writeFileSync(box.lane, "review zz-aaa1 4821\n");

  const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.code, 1);
  assert.equal(ran.lane, "STILL_HELD");
  assert.match(ran.out, /regular file/);
  assert.equal(readFileSync(box.lane, "utf8"), "review zz-aaa1 4821\n", "the file was removed");
});

test("a lane cannot be released without being told which one", () => {
  const ran = release(["--owner", "zz-aaa1"]);

  assert.equal(ran.code, 2);
  assert.match(ran.err, /--lane is required/);
});

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { site: { path: "repo", test: "npm test", role: "node" } },
};

const LANE_LOCK = "/tmp/pw-lane-4.lock";
const SLOT_FILE = "/tmp/pw-slots/3";

const TRIAGE_OK = {
  eligible: true,
  repo: "site",
  title: "a lane lock leaks",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

function releaseCall(calls: Call[]): Call {
  const found = calls.filter((c) => c.label === "release:zz-aaa1");
  const only = found[0];
  assert.ok(
    only,
    `the lane was never given back. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`,
  );
  assert.equal(found.length, 1, "the lane was released more than once");
  return only;
}

test("a run that ends in needs_feedback gives its lane and its slot back", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "needs_feedback", summary: "asks which shape ships", question: "which shape?" };
    return { lane: "released", slot: "released", notes: "lane: RELEASED" };
  });

  const result = await done;
  const prompt = releaseCall(calls).prompt;
  assert.match(prompt, /release-lane\.sh --lane \/tmp\/pw-lane-4\.lock --slot \/tmp\/pw-slots\/3 --owner 'zz-aaa1'/);
  assert.equal(result["outcome"], "needs_feedback");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
});

test("a slot that arrives as a string still names the lane the brief told the run to claim", async () => {
  const { calls, done } = runScript("task.js", { ...TASK_ARGS, slot: "3" }, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "needs a device" };
    return { lane: "released", slot: "released" };
  });

  await done;
  const prompt = releaseCall(calls).prompt;
  assert.match(prompt, /--lane \/tmp\/pw-lane-4\.lock /, "the lane number was built by string concatenation");
  assert.match(prompt, /--slot \/tmp\/pw-slots\/3 /);
});

test("a run that ends as a split gives its lane back, before the work loop ever starts", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) {
      return {
        ...TRIAGE_OK,
        eligible: false,
        splittable: true,
        reason: "two repositories",
        splitPlan: [
          { title: "the contract", repo: "integration", scope: "a field", autonomous: true },
          { title: "the consumer", repo: "site", scope: "reads it", autonomous: true },
        ],
      };
    }
    if (n === 2) return "created zz-aaa1.1 and zz-aaa1.2";
    return { lane: "released", slot: "released" };
  });

  const result = await done;
  releaseCall(calls);
  assert.equal(result["outcome"], "split");
});

test("a step that throws mid-run does not take the lane with it", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) throw new Error("the fix agent died mid-run");
    return { lane: "released", slot: "released" };
  });

  await assert.rejects(done, /died mid-run/);
  releaseCall(calls);
});

test("a handoff that dropped the lock itself is not reported as a leak", async () => {
  const { done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "pushed", summary: "fixed", prUrl: "https://example.test/pr/1" };
    if (n === 3) return { approved: true, notes: "good" };
    if (n === 4) return { status: "verified", verified: true, notes: "labelled" };
    return { lane: "already_gone", slot: "released" };
  });

  const result = await done;
  assert.equal(result["outcome"], "verified");
  assert.equal(result["lane"], "already_gone");
  assert.equal(result["slot"], "released");
});

test("a release step that answers nothing is reported as a leak naming what to read", async () => {
  const { logs, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "needs a device" };
    return null;
  });

  const result = await done;
  assert.match(String(result["lane"]), /^LEAKED/);
  assert.match(String(result["lane"]), new RegExp(LANE_LOCK.replace(/[/.]/g, "\\$&")));
  assert.match(String(result["slot"]), /^LEAKED/);
  assert.ok(
    logs.some((line) => line.includes("LEAKED") && line.includes(SLOT_FILE)),
    `a leaked lane was not reported in the log: ${logs.join(" | ")}`,
  );
});

test("the release step is one command and is not asked to look at the lock again afterwards", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "no_change_needed", summary: "the premise was wrong" };
    return { lane: "already_gone", slot: "released" };
  });

  await done;
  const prompt = releaseCall(calls).prompt;
  assert.equal(prompt.includes("`"), false, "a backtick in the prompt closes its template literal early");
  assert.equal((prompt.match(/release-lane\.sh/g) || []).length, 1, "the release command is written more than once");
  assert.equal(/\brmdir\b|\brm -/.test(prompt), false, "the release step is told to remove something by hand");
  assert.equal(/\bcat\b|\bls\b/.test(prompt), false, "the release step is asked to go and look at the lock itself");
});

test("every brief that takes a lane lock records the owner in the same command", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  const offenders = source
    .split("\n")
    .filter((line) => line.includes("mkdir /tmp/") && line.includes("-lane-"))
    .filter((line) => !line.includes(".owner"));
  assert.deepEqual(
    offenders,
    [],
    "a brief takes the lane lock without recording who holds it, so the release at the end of the " +
      `run cannot prove the lock is that run's own and the lane leaks:\n${offenders.join("\n")}`,
  );
});
