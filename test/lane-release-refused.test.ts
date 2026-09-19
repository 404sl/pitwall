import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const SLOT_SH = join(SKILL, "slot.sh");

const WT = mkdtempSync(join(tmpdir(), "lane-release-refused-"));
const WORKTREE = join(WT, "zz-aaa1");
const LANE_LOCK = "/tmp/pw-lane-4.lock";
const OWNER_FILE = "/tmp/pw-lane-4.owner";
const SLOT_FILE = "/tmp/pw-slots/3";

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
  title: "a refused release leaks the slot",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

const GIVEN_BACK = { lane: "released", slot: "released", worktree: "clean" };

function labelled(calls: Call[], label: string): Call[] {
  return calls.filter((c) => c.label === label);
}

function blocked(first: unknown, retry: unknown) {
  return runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "stopped: needs a device" };
    if (call.label === "release:zz-aaa1") {
      if (first instanceof Error) throw first;
      return first;
    }
    if (call.label === "release-retry:zz-aaa1") return retry;
    throw new Error(`unexpected step ${call.label}`);
  });
}

test("a release step that answers nothing is retried with plain commands that remove only what names the run", async () => {
  const { calls, done } = blocked(null, { lane: "released", slot: "released", notes: "slot: RELEASED\nlane: RELEASED" });
  const result = await done;

  const retries = labelled(calls, "release-retry:zz-aaa1");
  assert.equal(retries.length, 1, `the plain retry did not run exactly once. Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  const retry = retries[0]!;
  assert.equal(retry.prompt.includes("release-lane.sh"), false, "the retry runs the script the first step could not");
  assert.equal(retry.prompt.includes("`"), false, "a backtick in the prompt closes its template literal early");
  assert.ok(retry.prompt.includes(`rm -f ${SLOT_FILE}`), `the retry does not remove the slot file: ${retry.prompt}`);
  assert.ok(retry.prompt.includes(`rmdir ${LANE_LOCK}`), `the retry does not remove the lane lock: ${retry.prompt}`);
  assert.ok(retry.prompt.includes(`rm -f ${OWNER_FILE}`), `the retry does not remove the owner file: ${retry.prompt}`);
  assert.ok(
    retry.prompt.indexOf(`rm -f ${SLOT_FILE}`) < retry.prompt.indexOf(`rmdir ${LANE_LOCK}`),
    "the slot is the silent leak and goes first",
  );
  assert.match(retry.prompt, new RegExp(`\\[ "\\$\\(head -n 1 ${SLOT_FILE.replace(/[/.]/g, "\\$&")}\\)" = "zz-aaa1" \\]; then rm -f`), "the slot is removed without checking that it names this run");
  assert.match(retry.prompt, /awk 'NR == 1 \{ print \$1 \}' \/tmp\/pw-lane-4\.owner 2>\/dev\/null\)" = "zz-aaa1" \]/, "the lane is removed without checking the owner file names this run");
  assert.deepEqual((retry.schema as { required: string[] }).required, ["lane", "slot"]);
  assert.ok(((retry.schema as { properties: { slot: { enum: string[] } } }).properties.slot.enum).includes("refused"));

  assert.equal(result["outcome"], "blocked");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
  assert.match(String(result["worktree"]), /^UNKNOWN - /, "the retry never reads the worktree, so the field must not claim clean");
});

test("a release step that says it was refused is retried the same way, and its own worktree answer is not kept", async () => {
  const { calls, done } = blocked({ lane: "refused", slot: "refused", worktree: "refused", notes: "not permitted" }, { lane: "already_gone", slot: "released" });
  const result = await done;
  assert.equal(labelled(calls, "release-retry:zz-aaa1").length, 1);
  assert.equal(result["lane"], "already_gone");
  assert.equal(result["slot"], "released");
  assert.match(String(result["worktree"]), /^UNKNOWN - /);
});

test("the first release step now accepts refused, and tells the step to say so rather than guess", async () => {
  const { calls, done } = blocked(GIVEN_BACK, null);
  await done;
  const first = labelled(calls, "release:zz-aaa1")[0]!;
  assert.deepEqual((first.schema as { required: string[] }).required, ["lane", "slot", "worktree"]);
  const props = (first.schema as { properties: Record<string, { enum: string[] }> }).properties;
  for (const field of ["lane", "slot", "worktree"]) {
    assert.ok(props[field]!.enum.includes("refused"), `${field} cannot be reported as refused`);
  }
  assert.match(first.prompt, /report 'refused' for all three/);
  assert.equal(first.prompt.includes("`"), false);
});

test("a release step that answers in full is not retried", async () => {
  const { calls, done } = blocked(GIVEN_BACK, null);
  const result = await done;
  assert.equal(labelled(calls, "release-retry:zz-aaa1").length, 0, "a lane that was given back was released a second time");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
  assert.equal(result["worktree"], `clean - ${WORKTREE}`);
});

test("a release step that ran and reported still_held is a leak, not a refusal, and is not retried", async () => {
  const { calls, done } = blocked({ lane: "still_held", slot: "released", worktree: "clean", notes: "lane: STILL_HELD" }, null);
  const result = await done;
  assert.equal(labelled(calls, "release-retry:zz-aaa1").length, 0);
  assert.match(String(result["lane"]), /^LEAKED - /);
  assert.equal(result["slot"], "released");
});

test("a release refused twice is recorded as REFUSED in both fields, each naming its path and carrying the plain command that releases it", async () => {
  const { calls, logs, done } = blocked({ lane: "refused", slot: "refused", worktree: "refused", notes: "blocked by safety classifier: [Auto-Mode Bypass]" }, null);
  const result = await done;

  const retry = labelled(calls, "release-retry:zz-aaa1");
  assert.equal(retry.length, 1);
  const [slotCommand, laneCommand] = commandsOf(retry[0]!.prompt);
  assert.equal(result["outcome"], "blocked");
  for (const [field, path, command] of [["lane", LANE_LOCK, laneCommand], ["slot", SLOT_FILE, slotCommand]] as const) {
    const value = String(result[field]);
    assert.match(value, /^REFUSED - /, `${field} reads: ${value}`);
    assert.ok(value.includes(path), `${field} does not name ${path}: ${value}`);
    assert.ok(command && value.endsWith(command), `${field} does not end with the plain command the retry was given: ${value}`);
    assert.equal(value.includes("slot.sh --release"), false, `${field} points at slot.sh, which reaches a lane lock only through a slot file: ${value}`);
    assert.equal(value.includes("LEAKED"), false, "a refusal read as a leak sends a person to read a file the release never touched");
  }
  assert.ok(String(result["lane"]).includes(`rmdir ${LANE_LOCK}`), `the lane field does not remove the lock on its own: ${result["lane"]}`);
  assert.ok(String(result["lane"]).includes(`awk 'NR == 1 { print $1 }' ${OWNER_FILE}`), `the lane field does not read the owner file: ${result["lane"]}`);
  assert.ok(String(result["slot"]).includes(`rm -f ${SLOT_FILE}`), `the slot field does not remove the slot file: ${result["slot"]}`);
  assert.match(String(result["worktree"]), /^UNKNOWN - /);

  const line = logs.find((l) => l.startsWith("lane 4: REFUSED - "));
  assert.ok(line, `the console never said the release was refused: ${logs.join(" | ")}`);
  assert.ok(line.includes("slot 3: REFUSED - "), `the console line does not carry the slot: ${line}`);
  assert.ok(line.includes("blocked by safety classifier: [Auto-Mode Bypass]"), `a retry that answered nothing dropped what refused the first step: ${line}`);
});

test("the first refusal is logged with its reason before the retry, so a classifier refusing every run is visible when the retry succeeds", async () => {
  const { logs, done } = blocked({ lane: "refused", slot: "refused", worktree: "refused", notes: "blocked by safety classifier: [Auto-Mode Bypass]" }, { lane: "released", slot: "released" });
  const result = await done;
  assert.equal(result["lane"], "released");
  const line = logs.find((l) => l.startsWith("release:zz-aaa1: release-lane.sh was refused, retrying as plain commands"));
  assert.ok(line, `nothing was logged about the refusal: ${logs.join(" | ")}`);
  assert.ok(line.includes("blocked by safety classifier: [Auto-Mode Bypass]"), `the log line dropped the reason: ${line}`);

  const silent = blocked(null, { lane: "released", slot: "released" });
  await silent.done;
  assert.ok(silent.logs.some((l) => l.startsWith("release:zz-aaa1: release-lane.sh was not answered, retrying as plain commands")), silent.logs.join(" | "));
});

test("a retry that is itself refused is REFUSED, and a field the retry did give back is not", async () => {
  const { done } = blocked(null, { lane: "refused", slot: "released", notes: "the lane command was not permitted" });
  const result = await done;
  assert.match(String(result["lane"]), /^REFUSED - /);
  assert.ok(String(result["lane"]).includes(`rmdir ${LANE_LOCK}`), `with the slot already gone, the lane field must release the lock without going through the slot: ${result["lane"]}`);
  assert.equal(result["slot"], "released");

  const ran = blocked(null, { lane: "still_held", slot: "refused", notes: "rmdir: directory not empty" });
  const mixed = await ran.done;
  assert.match(String(mixed["lane"]), /^LEAKED - /, "a lock the retry ran against and could not remove is a leak to read, not a refusal");
  assert.match(String(mixed["slot"]), /^REFUSED - /);
});

test("a release step that dies rather than answering does not take the run's result with it", async () => {
  const { calls, logs, done } = blocked(new Error("the release step was killed before it answered"), { lane: "released", slot: "released" });
  const result = await done;
  assert.equal(result["outcome"], "blocked", "the run's own outcome was lost to the release step dying");
  assert.equal(labelled(calls, "release-retry:zz-aaa1").length, 1, "a release step that died was not retried");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
  assert.ok(
    logs.some((l) => l.startsWith("release:zz-aaa1: the release step died before answering - ") && l.includes("killed before it answered")),
    `the log does not say the first release step died: ${logs.join(" | ")}`,
  );
});

test("a fix step that threw still surfaces its own error when the release step dies too", async () => {
  const { done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) throw new Error("the fix agent died mid-run");
    throw new Error("the release step was killed");
  });
  await assert.rejects(done, /fix agent died mid-run/);
});

function commandsOf(prompt: string): string[] {
  return prompt.split("\n").filter((l) => l.startsWith("  if [ ")).map((l) => l.trim());
}

async function plainCommands(prefix: string): Promise<string[]> {
  const { calls, done } = runScript("task.js", { ...TASK_ARGS, lockPrefix: prefix }, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "stopped" };
    if (call.label === "release:zz-aaa1") return null;
    return { lane: "released", slot: "released" };
  });
  await done;
  const retry = labelled(calls, "release-retry:zz-aaa1")[0];
  assert.ok(retry, "no retry ran");
  const commands = commandsOf(retry.prompt);
  assert.equal(commands.length, 2, `expected two plain commands, found: ${commands.join(" || ")}`);
  return commands;
}

function sh(command: string) {
  const ran = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  return { status: ran.status ?? -1, out: (ran.stdout ?? "").trim(), err: ran.stderr ?? "" };
}

test("the plain commands release what names the run, leave what does not, and say gone the second time", async () => {
  const prefix = `pwplain${process.pid}`;
  const slots = slotsPath(prefix);
  const slot = join(slots, "3");
  const lock = join(LOCK_ROOT, `${prefix}-lane-4.lock`);
  const owner = join(LOCK_ROOT, `${prefix}-lane-4.owner`);
  const [slotCommand, laneCommand] = await plainCommands(prefix);
  assert.ok(slotCommand && laneCommand);
  try {
    mkdirSync(slots, { recursive: true });
    writeFileSync(slot, "zz-aaa1\n");
    mkdirSync(lock);
    writeFileSync(owner, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4 dispatch d1\n");

    assert.equal(sh(slotCommand).out, "slot: RELEASED");
    assert.equal(existsSync(slot), false);
    assert.equal(sh(laneCommand).out, "lane: RELEASED");
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(owner), false);

    assert.equal(sh(slotCommand).out, "slot: ALREADY_GONE");
    assert.equal(sh(laneCommand).out, "lane: ALREADY_GONE");

    writeFileSync(slot, "zz-bbb2\n");
    mkdirSync(lock);
    writeFileSync(owner, "zz-bbb2 slot 3 TEST_ENV_NUMBER 4\n");
    assert.equal(sh(slotCommand).out, "slot: NOT_MINE - zz-bbb2");
    assert.equal(existsSync(slot), true, "a slot naming another run was removed");
    assert.equal(sh(laneCommand).out, "lane: NOT_MINE - zz-bbb2 slot 3 TEST_ENV_NUMBER 4");
    assert.equal(existsSync(lock), true, "a lane lock owned by another run was removed");

    rmSync(owner, { force: true });
    assert.equal(sh(laneCommand).out, "lane: NOT_MINE -", "a lock with no owner file is nobody's to remove");
    assert.equal(existsSync(lock), true);

    rmSync(lock, { recursive: true, force: true });
    writeFileSync(lock, "review zz-aaa1 123\n");
    assert.equal(sh(laneCommand).out, "lane: STILL_HELD - a regular file, not a lock");
    assert.equal(existsSync(lock), true, "a regular file at the lock path is a fault to report, not a lock to clear");
  } finally {
    rmSync(slots, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
    rmSync(owner, { force: true });
  }
});

test("the lane command a REFUSED field carries releases a lock whose slot file is already gone", async () => {
  const prefix = `pwmixed${process.pid}`;
  const slots = slotsPath(prefix);
  const lock = join(LOCK_ROOT, `${prefix}-lane-4.lock`);
  const owner = join(LOCK_ROOT, `${prefix}-lane-4.owner`);
  const { done } = runScript("task.js", { ...TASK_ARGS, lockPrefix: prefix }, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "stopped" };
    if (call.label === "release:zz-aaa1") return null;
    return { lane: "refused", slot: "released", notes: "the lane command was not permitted" };
  });
  const result = await done;
  const value = String(result["lane"]);
  const command = value.slice(value.lastIndexOf(": if [ ") + 2);
  assert.ok(command.startsWith("if [ "), `no command at the end of the lane field: ${value}`);
  try {
    mkdirSync(slots, { recursive: true });
    mkdirSync(lock);
    writeFileSync(owner, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4\n");
    assert.equal(existsSync(join(slots, "3")), false);

    assert.equal(sh(command).out, "lane: RELEASED");
    assert.equal(existsSync(lock), false, "the lock the field named is still there after its own command ran");
    assert.equal(existsSync(owner), false);
    assert.equal(sh(command).out, "lane: ALREADY_GONE");
  } finally {
    rmSync(slots, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
    rmSync(owner, { force: true });
  }
});

let sequence = 0;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pitwall-slot-release-"));
  const prefix = `pwrelease${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ root, idPrefix: "zz", lockPrefix: prefix, lanes: 3, repos: { site: { path: "repo" } } }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bd"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "bd"), 0o755);
  return { root, prefix, config, bin, slots: slotsPath(prefix) };
}

function release(box: ReturnType<typeof workspace>, id: string) {
  const ran = spawnSync("bash", [SLOT_SH, "--release", id], {
    encoding: "utf8",
    cwd: box.root,
    env: { ...process.env, ...GIT_ENV, PATH: `${box.bin}:${process.env["PATH"] ?? ""}`, PITWALL_CONFIG: box.config, BEADS_DIR: "" },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function clean(box: ReturnType<typeof workspace>) {
  rmSync(box.slots, { recursive: true, force: true });
  for (let lane = 1; lane <= 9; lane += 1) {
    rmSync(join(LOCK_ROOT, `${box.prefix}-lane-${lane}.lock`), { recursive: true, force: true });
    rmSync(join(LOCK_ROOT, `${box.prefix}-lane-${lane}.owner`), { force: true });
  }
  rmSync(box.root, { recursive: true, force: true });
}

test("slot.sh --release says when no slot names the id and that it did not read the lane locks, and leaves a slot-less lock alone", () => {
  const box = workspace();
  try {
    mkdirSync(box.slots, { recursive: true });
    writeFileSync(join(box.slots, "2"), "zz-aaa1\n");
    const lock = join(LOCK_ROOT, `${box.prefix}-lane-3.lock`);
    mkdirSync(lock);
    writeFileSync(join(LOCK_ROOT, `${box.prefix}-lane-3.owner`), "zz-aaa1 slot 2 TEST_ENV_NUMBER 3\n");

    const first = release(box, "zz-aaa1");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /released slot 2 and lane 3/);
    assert.equal(existsSync(join(box.slots, "2")), false);
    assert.equal(existsSync(lock), false);

    const again = release(box, "zz-aaa1");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^no slot under \S+ names zz-aaa1, so no slot was released\./, `a second release printed: [${again.stdout}]`);
    assert.ok(again.stdout.includes(`/tmp/${box.prefix}-lane-*.owner file may still name zz-aaa1, and this does not read them`), `the line reads as all-clear: [${again.stdout}]`);
    assert.equal(existsSync(box.slots), true, "the registry directory was removed by a release of nothing");

    mkdirSync(lock);
    writeFileSync(join(LOCK_ROOT, `${box.prefix}-lane-3.owner`), "zz-aaa1 slot 2 TEST_ENV_NUMBER 3\n");
    const orphan = release(box, "zz-aaa1");
    assert.equal(orphan.status, 0, orphan.stderr);
    assert.match(orphan.stdout, /^no slot under /, `a release with a lock but no slot printed: [${orphan.stdout}]`);
    assert.equal(existsSync(lock), true, "slot.sh --release is documented as reaching a lock only through its slot; if it now sweeps owner files, update the lane field's text and this test together");
  } finally {
    clean(box);
  }
});
