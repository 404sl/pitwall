import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";
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
  const ran = spawnSync("bash", [RELEASE_LANE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
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

test("a lane lock with anything inside it is a fault, not a lane to remove", () => {
  const box = held("zz-aaa1");
  writeFileSync(join(box.lane, "holder"), "review zz-aaa1 4821\n");

  const ran = release(["--lane", box.lane, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.code, 1);
  assert.equal(ran.lane, "STILL_HELD");
  assert.equal(existsSync(box.lane), true, "a lock that is not a bare directory was removed anyway");
  assert.equal(existsSync(join(box.lane, "holder")), true, "the contents of the lock were removed");
});

test("a path that is not shaped like a lane lock is refused before anything is removed", () => {
  const box = held("zz-aaa1");
  const notALock = box.lane.replace(/pw-lane-4\.lock$/, "pw-slots");

  const ran = release(["--lane", notALock, "--slot", box.slot, "--owner", "zz-aaa1"]);

  assert.equal(ran.code, 2);
  assert.equal(ran.out, "", "a refusal reported an outcome on stdout");
  assert.match(ran.err, /REFUSED/);
  assert.equal(existsSync(notALock), true, "a path that is not a lane lock was removed");
  assert.equal(existsSync(box.slot), true, "the slot was released on a refused path");
});

test("nothing that drops a lane lock leaves its owner file behind", () => {
  for (const name of ["release-lane.sh", "lane-handoff.sh", "slot.sh", "kill-lane.sh"]) {
    const lines = readFileSync(join(SKILL, name), "utf8").split("\n");
    const drops = lines
      .map((line, i) => ({ line, at: i + 1 }))
      .filter(({ line }) => /\brmdir\b/.test(line))
      .filter(({ line }) => !/^\s*(#|echo)/.test(line));
    assert.ok(drops.length > 0, `${name} no longer drops a lane lock - take it off this list`);
    for (const { line, at } of drops) {
      assert.match(
        lines.slice(Math.max(0, at - 3), at).join("\n"),
        /rm -f [^\n]*(\.owner|ownerfile)/,
        `${name}:${at} drops a lane lock without removing the owner file beside it first. That file ` +
          "is the proof of ownership the release reads, so a second run can take the lane while a file " +
          "naming the finished run still stands beside it - and a release proving itself against that " +
          `file removes a live lane's lock:\n${line}`,
      );
    }
  }
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

const TRIAGE_SPLIT = {
  ...TRIAGE_OK,
  eligible: false,
  splittable: true,
  reason: "two repositories",
  splitPlan: [
    { title: "the contract", repo: "integration", scope: "a field", autonomous: true },
    { title: "the consumer", repo: "site", scope: "reads it", autonomous: true },
  ],
};

test("a run that ends as a split gives its lane back, before the work loop ever starts", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_SPLIT;
    if (n === 2) return "created zz-aaa1.1 and zz-aaa1.2";
    return { lane: "released", slot: "released" };
  });

  const result = await done;
  releaseCall(calls);
  assert.equal(result["outcome"], "split");
  assert.equal(
    result["lane"],
    undefined,
    "a split returns before the release step answers - JavaScript evaluates the return expression " +
      "first - so the result cannot carry the outcome and the log is where the leak is reported. If " +
      "this field now exists, say so in SKILL.md and the changelog, which claim only the log for a split",
  );
  assert.equal(result["slot"], undefined);
});

test("a split whose release answers nothing still reports the leak in the log", async () => {
  const { logs, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_SPLIT;
    if (n === 2) return "created zz-aaa1.1 and zz-aaa1.2";
    return null;
  });

  const result = await done;
  assert.equal(result["outcome"], "split");
  assert.ok(
    logs.some((line) => line.includes("LEAKED") && line.includes(LANE_LOCK) && line.includes(SLOT_FILE)),
    "a split is the outcome the lane lock leaked from most often, and it is the one outcome whose " +
      `result cannot carry the answer, so the log has to: ${logs.join(" | ")}`,
  );
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
  for (const file of ["task.js", "rework.js"]) {
    const source = readFileSync(join(SKILL, file), "utf8");
    const offenders = source
      .split("\n")
      .filter((line) => /mkdir (\/tmp\/\S*-lane-|\$\{LANE_LOCK\})/.test(line))
      .filter((line) => !line.includes(".owner") && !line.includes("OWNER_FILE"));
    assert.deepEqual(
      offenders,
      [],
      `${file} takes the lane lock without recording who holds it, so the release at the end of ` +
        `the run cannot prove the lock is that run's own and the lane leaks:\n${offenders.join("\n")}`,
    );
  }
});

const REWORK_ARGS = {
  id: "zz-aaa1",
  pr: 739,
  repo: "site",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { site: { slug: "acme/site", path: "repo", test: "npm test" } },
};

const RESOLVED = { status: "resolved", branch: "devloop/zz-aaa1", oldHead: "aaaaaaa", newHead: "bbbbbbb", files: ["db/schema.rb"] };

function reworkRelease(calls: Call[]): Call {
  const found = calls.filter((c) => c.label === "release:zz-aaa1#739");
  const only = found[0];
  assert.ok(
    only,
    `the lane was never given back. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`,
  );
  assert.equal(found.length, 1, "the lane was released more than once");
  return only;
}

test("a rework whose pull request comes back red gives its lane and its slot back", async () => {
  const { calls, done } = runScript("rework.js", REWORK_ARGS, (call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return { status: "red", ciConclusion: "failure", notes: "two specs failed" };
    return { lane: "released", slot: "released", notes: "lane: RELEASED" };
  });

  const result = await done;
  const prompt = reworkRelease(calls).prompt;
  assert.match(prompt, /release-lane\.sh --lane \/tmp\/pw-lane-4\.lock --slot \/tmp\/pw-slots\/3 --owner 'zz-aaa1'/);
  assert.equal(result["outcome"], "red");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
});

test("a rework blocked at the merge gives the lane back without running the handoff", async () => {
  const { calls, done } = runScript("rework.js", REWORK_ARGS, (call, n) => {
    if (n === 1) return { status: "blocked", notes: "the push was refused" };
    return { lane: "released", slot: "released" };
  });

  const result = await done;
  reworkRelease(calls);
  assert.equal(result["outcome"], "blocked");
  assert.equal(result["lane"], "released");
  assert.equal(
    calls.some((c) => c.label === "handoff:zz-aaa1#739"),
    false,
    "a blocked merge went on to hand off anyway",
  );
});

test("a rework whose step throws does not take the lane with it", async () => {
  const { calls, done } = runScript("rework.js", REWORK_ARGS, (call, n) => {
    if (n === 1) throw new Error("the resolve agent died mid-merge");
    return { lane: "released", slot: "released" };
  });

  await assert.rejects(done, /died mid-merge/);
  reworkRelease(calls);
});

test("a rework dispatched with no slot asks for no slot back and says so", async () => {
  const args: Record<string, unknown> = { ...REWORK_ARGS };
  delete args["slot"];
  const { calls, done } = runScript("rework.js", args, (call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return { status: "verified", ciConclusion: "success", notes: "labelled" };
    return { lane: "already_gone" };
  });

  const result = await done;
  const release = reworkRelease(calls);
  assert.equal(
    /--slot/.test(release.prompt),
    false,
    "a run given no slot was told to give back slot 1, which belongs to whichever run reserved it",
  );
  assert.match(release.prompt, /--lane \/tmp\/pw-lane-2\.lock --owner 'zz-aaa1'/);
  assert.deepEqual((release.schema as { required: string[] }).required, ["lane"]);
  assert.equal(result["lane"], "already_gone");
  assert.match(String(result["slot"]), /^not_reserved/);
});

test("a rework release step that answers nothing is reported as a leak naming what to read", async () => {
  const { logs, done } = runScript("rework.js", REWORK_ARGS, (call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return { status: "red", ciConclusion: "failure" };
    return null;
  });

  const result = await done;
  assert.match(String(result["lane"]), /^LEAKED/);
  assert.match(String(result["lane"]), new RegExp(LANE_LOCK.replace(/[/.]/g, "\\$&")));
  assert.ok(
    logs.some((line) => line.includes("LEAKED") && line.includes(LANE_LOCK) && line.includes(SLOT_FILE)),
    `a leaked lane was not reported in the log: ${logs.join(" | ")}`,
  );
});

test("a rework's release step is one command and carries no backtick", async () => {
  const { calls, done } = runScript("rework.js", REWORK_ARGS, (call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return { status: "verified", ciConclusion: "success" };
    return { lane: "already_gone", slot: "released" };
  });

  await done;
  const prompt = reworkRelease(calls).prompt;
  assert.equal(prompt.includes("`"), false, "a backtick in the prompt closes its template literal early");
  assert.equal(
    calls[0]?.prompt.includes("`"),
    false,
    "a backtick in the brief that takes the lane lock closes its template literal early - the file " +
      "stays valid JavaScript and becomes a different program, so node --check and CI both pass",
  );
  assert.equal((prompt.match(/release-lane\.sh/g) || []).length, 1, "the release command is written more than once");
  assert.equal(/\brmdir\b|\brm -/.test(prompt), false, "the release step is told to remove something by hand");
});

test("a rework given a slot as a string releases the lane its own brief claimed", async () => {
  const { calls, done } = runScript("rework.js", { ...REWORK_ARGS, slot: "3" }, (call, n) => {
    if (n === 1) return { status: "blocked", notes: "the push was refused" };
    return { lane: "released", slot: "released" };
  });

  await done;
  const claimed = calls[0]?.prompt.match(/mkdir (\S+\.lock)/);
  assert.ok(claimed, "the resolve brief no longer tells the lane which lock to take");
  assert.match(
    reworkRelease(calls).prompt,
    new RegExp(`--lane ${claimed[1]?.replace(/[/.]/g, "\\$&")} `),
    "the release names a different lane from the one the brief told the run to claim, so the lock " +
      "it actually holds is left standing and reads already_gone",
  );
});

test("a rework given a slot as a string claims the lane that slot maps to", async () => {
  const { calls, done } = runScript("rework.js", { ...REWORK_ARGS, slot: "3" }, (call, n) => {
    if (n === 1) return { status: "blocked", notes: "the push was refused" };
    return { lane: "released", slot: "released" };
  });

  await done;
  assert.match(
    calls[0]?.prompt ?? "",
    /mkdir \/tmp\/pw-lane-4\.lock /,
    "the lane number was built by string concatenation, so slot '3' claimed lane 31 rather than 4 - " +
      "the brief and the release still agree, so the lock holds, but TEST_ENV_NUMBER then names a " +
      "database no other lane is excluded from, which is what the lane lock exists to prevent",
  );
  assert.match(calls[0]?.prompt ?? "", /TEST_ENV_NUMBER 4"/, "the owner file records a different number from the lock");
  assert.match(reworkRelease(calls).prompt, /--lane \/tmp\/pw-lane-4\.lock --slot \/tmp\/pw-slots\/3 /);
});
