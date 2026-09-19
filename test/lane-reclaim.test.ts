import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOCK_ROOT } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const RELEASE_LANE = join(SKILL, "release-lane.sh");

let sequence = 0;

function prefix(): string {
  return `pwreclaim${process.pid}x${(sequence += 1)}`;
}

function taskArgs(lockPrefix: string, dispatch?: string) {
  return {
    id: "zz-aaa1",
    slot: 3,
    root: "/root",
    skillDir: "/skill",
    lockPrefix,
    ...(dispatch === undefined ? {} : { dispatch }),
    repos: { site: { path: "repo", test: "npm test", role: "rails" } },
  };
}

const TRIAGE_OK = {
  eligible: true,
  repo: "site",
  title: "a retry cannot tell its own lock from a stranger's",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

async function fixBrief(args: ReturnType<typeof taskArgs>): Promise<string> {
  const { calls, done } = runScript("task.js", args, (call: Call, n: number) => {
    if (n === 1) return TRIAGE_OK;
    if (call.label.startsWith("fix:")) return { status: "blocked", summary: "stopped after reading the brief" };
    return { lane: "released", slot: "released" };
  });
  await done;
  const fix = calls.find((c) => c.label === "fix:zz-aaa1");
  assert.ok(fix, `no fix step was run. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return fix.prompt;
}

function claimLine(brief: string): string {
  const lines = brief.split("\n").filter((line) => /^\s*mkdir \/tmp\/\S+-lane-4\.lock /.test(line));
  assert.equal(lines.length, 1, `expected exactly one lane claim command in the brief, found:\n${lines.join("\n")}`);
  return lines[0]!.trim();
}

function sh(command: string): string {
  const ran = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return (ran.stdout ?? "").trim();
}

function clean(lockPrefix: string): void {
  rmSync(join(LOCK_ROOT, `${lockPrefix}-lane-4.lock`), { recursive: true, force: true });
  rmSync(join(LOCK_ROOT, `${lockPrefix}-lane-4.owner`), { force: true });
}

test("a retry that finds its own dispatch's lock reclaims it, and a stranger's lock still refuses", async () => {
  const pfx = prefix();
  const lock = join(LOCK_ROOT, `${pfx}-lane-4.lock`);
  const owner = join(LOCK_ROOT, `${pfx}-lane-4.owner`);
  try {
    const claim = claimLine(await fixBrief(taskArgs(pfx, "d3adb33f00000001")));
    assert.equal(claim.includes("`"), false, "a backtick in the claim command closes the brief's template literal early");

    assert.equal(sh(claim), "GOT_LANE");
    assert.equal(readFileSync(owner, "utf8"), "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch d3adb33f00000001\n");

    assert.equal(sh(claim), "LANE_RECLAIMED", "the same dispatch finding its own earlier lock was refused");
    assert.equal(existsSync(lock), true, "reclaiming dropped the lock");
    assert.equal(readFileSync(owner, "utf8"), "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch d3adb33f00000001\n");

    writeFileSync(owner, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch 0000000000000002\n");
    assert.equal(sh(claim), "LANE_BUSY", "the same issue under another dispatch was treated as this run's own");
    assert.equal(readFileSync(owner, "utf8"), "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch 0000000000000002\n");

    writeFileSync(owner, "zz-bbb2 slot 3 TEST_ENV_NUMBER 4 dispatch d3adb33f00000001\n");
    assert.equal(sh(claim), "LANE_BUSY", "another issue's lock was treated as this run's own");

    writeFileSync(owner, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4\n");
    assert.equal(sh(claim), "LANE_BUSY", "a lock taken before tokens existed proves nothing and was reclaimed anyway");

    rmSync(owner, { force: true });
    assert.equal(sh(claim), "LANE_BUSY", "a lock with no owner file was reclaimed");

    rmSync(lock, { recursive: true, force: true });
    writeFileSync(lock, "review zz-aaa1 4821\n");
    writeFileSync(owner, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch d3adb33f00000001\n");
    assert.equal(sh(claim), "LANE_BUSY", "a regular file at the lock path was read as a lane this run holds");
  } finally {
    clean(pfx);
  }
});

test("the brief explains LANE_RECLAIMED only when the run carries a dispatch token", async () => {
  const withToken = await fixBrief(taskArgs(prefix(), "d3adb33f00000001"));
  assert.match(withToken, /LANE_RECLAIMED MEANS THE LANE IS ALREADY YOURS/);
  assert.match(withToken, /dispatch d3adb33f00000001/);
  assert.equal(withToken.includes("`"), false, "a backtick in the brief closes its template literal early");

  const without = await fixBrief(taskArgs(prefix()));
  assert.equal(without.includes("LANE_RECLAIMED"), false, "a run with no token was told it could reclaim a lock it cannot prove is its own");
  const claim = claimLine(without);
  assert.equal(claim.includes(" dispatch "), false, "a run with no token wrote a dispatch field anyway");
  assert.match(claim, /TEST_ENV_NUMBER 4" > \/tmp\/\S+-lane-4\.owner && echo GOT_LANE \|\| echo LANE_BUSY$/);
});

test("a dispatch token that could break the claim command is dropped rather than rendered", async () => {
  for (const bad of ['a"b', "a b", "a;b", "$(id)", ""]) {
    const brief = await fixBrief(taskArgs(prefix(), bad));
    assert.equal(brief.includes("LANE_RECLAIMED"), false, `token ${JSON.stringify(bad)} reached the brief`);
  }
});

test("release-lane.sh still proves ownership from an owner file that carries a dispatch token", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-reclaim-"));
  const lane = join(dir, "pw-lane-4.lock");
  mkdirSync(lane);
  const ownerFile = join(dir, "pw-lane-4.owner");
  writeFileSync(ownerFile, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch d3adb33f00000001\n");
  mkdirSync(join(dir, "pw-slots"));
  const slot = join(dir, "pw-slots", "3");
  writeFileSync(slot, "zz-aaa1\n");

  const ran = spawnSync("bash", [RELEASE_LANE, "--lane", lane, "--slot", slot, "--owner", "zz-aaa1"], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });

  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^lane: RELEASED$/m);
  assert.equal(existsSync(lane), false, "the lane lock is still held");
  assert.equal(existsSync(ownerFile), false, "the owner file outlived the lock");
});
