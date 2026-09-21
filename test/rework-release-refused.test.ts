import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const LANE_LOCK = "/tmp/pw-lane-4.lock";
const OWNER_FILE = "/tmp/pw-lane-4.owner";
const SLOT_FILE = "/tmp/pw-slots/3";

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
const GIVEN_BACK = { lane: "released", slot: "released", notes: "lane: RELEASED\nslot: RELEASED" };

function labelled(calls: Call[], label: string): Call[] {
  return calls.filter((c) => c.label === label);
}

function red(first: unknown, retry: unknown, args: Record<string, unknown> = REWORK_ARGS) {
  return runScript("rework.js", args, (call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return { status: "red", ciConclusion: "failure", notes: "two specs failed" };
    if (n === 3) return { status: "blocked", notes: "the two specs assert what master now forbids" };
    if (call.label === "release:zz-aaa1#739") {
      if (first instanceof Error) throw first;
      return first;
    }
    if (call.label === "release-retry:zz-aaa1#739") return retry;
    throw new Error(`unexpected step ${call.label}`);
  });
}

function commandsOf(prompt: string): string[] {
  return prompt.split("\n").filter((l) => l.startsWith("  if [ ")).map((l) => l.trim());
}

function sh(command: string) {
  const ran = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return { status: ran.status ?? -1, out: (ran.stdout ?? "").trim(), err: ran.stderr ?? "" };
}

test("a rework release step that answers nothing is retried with plain commands that remove only what names the run", async () => {
  const { calls, done } = red(null, GIVEN_BACK);
  const result = await done;

  const retries = labelled(calls, "release-retry:zz-aaa1#739");
  assert.equal(retries.length, 1, `the plain retry did not run exactly once. Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  const retry = retries[0]!;
  assert.equal(retry.prompt.includes("release-lane.sh"), false, "the retry runs the script the first step could not");
  assert.equal(retry.prompt.includes("`"), false, "a backtick in the prompt closes its template literal early");
  assert.equal(/worktree/i.test(retry.prompt), false, "a rework carries no worktree field and the retry must not read one");
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

  assert.equal(labelled(calls, "release:zz-aaa1#739").length, 1, "the first release step ran more than once");
  assert.equal(result["outcome"], "red");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
  assert.equal("worktree" in result, false, "a rework result grew a worktree field it has nothing to fill from");
});

test("a rework release step that says it was refused is retried the same way", async () => {
  const { calls, done } = red({ lane: "refused", slot: "refused", notes: "not permitted" }, { lane: "already_gone", slot: "released" });
  const result = await done;
  assert.equal(labelled(calls, "release-retry:zz-aaa1#739").length, 1);
  assert.equal(result["lane"], "already_gone");
  assert.equal(result["slot"], "released");
});

test("a rework release step that dies rather than answering is retried and does not take the run's result with it", async () => {
  const { calls, logs, done } = red(new Error("the release step was killed before it answered"), GIVEN_BACK);
  const result = await done;
  assert.equal(result["outcome"], "red", "the run's own outcome was lost to the release step dying");
  assert.equal(labelled(calls, "release-retry:zz-aaa1#739").length, 1, "a release step that died was not retried");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
  assert.ok(
    logs.some((l) => l.startsWith("release:zz-aaa1#739: the release step died before answering - ") && l.includes("killed before it answered")),
    `the log does not say the first release step died: ${logs.join(" | ")}`,
  );
});

test("the first rework release step accepts refused and tells the step to say so rather than guess", async () => {
  const { calls, done } = red(GIVEN_BACK, null);
  await done;
  const first = labelled(calls, "release:zz-aaa1#739")[0]!;
  assert.deepEqual((first.schema as { required: string[] }).required, ["lane", "slot"]);
  const props = (first.schema as { properties: Record<string, { enum: string[] }> }).properties;
  for (const field of ["lane", "slot"]) {
    assert.ok(props[field]!.enum.includes("refused"), `${field} cannot be reported as refused`);
  }
  assert.match(first.prompt, /report 'refused'\s+for both/);
  assert.equal(first.prompt.includes("`"), false);
});

test("a rework release step that answers in full is not retried", async () => {
  const { calls, done } = red(GIVEN_BACK, null);
  const result = await done;
  assert.equal(labelled(calls, "release-retry:zz-aaa1#739").length, 0, "a lane that was given back was released a second time");
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
});

test("a rework release step that ran and reported still_held is a leak, not a refusal, and is not retried", async () => {
  const { calls, done } = red({ lane: "still_held", slot: "released", notes: "lane: STILL_HELD" }, null);
  const result = await done;
  assert.equal(labelled(calls, "release-retry:zz-aaa1#739").length, 0);
  assert.match(String(result["lane"]), /^LEAKED - /);
  assert.equal(result["slot"], "released");
});

test("a rework release refused twice is recorded as REFUSED in both fields, each naming its path and carrying the plain command that releases it", async () => {
  const { calls, logs, done } = red({ lane: "refused", slot: "refused", notes: "blocked by safety classifier: [Auto-Mode Bypass]" }, null);
  const result = await done;

  const retry = labelled(calls, "release-retry:zz-aaa1#739");
  assert.equal(retry.length, 1);
  const [slotCommand, laneCommand] = commandsOf(retry[0]!.prompt);
  assert.equal(result["outcome"], "red");
  for (const [field, path, command] of [["lane", LANE_LOCK, laneCommand], ["slot", SLOT_FILE, slotCommand]] as const) {
    const value = String(result[field]);
    assert.match(value, /^REFUSED - /, `${field} reads: ${value}`);
    assert.ok(value.includes(path), `${field} does not name ${path}: ${value}`);
    assert.ok(command && value.endsWith(command), `${field} does not end with the plain command the retry was given: ${value}`);
    assert.equal(value.includes("slot.sh --release"), false, `${field} points at slot.sh, which reaches a lane lock only through a slot file: ${value}`);
    assert.equal(value.includes("LEAKED"), false, "a refusal read as a leak sends a person to read a file the release never touched");
  }
  assert.ok(String(result["lane"]).includes(`rmdir ${LANE_LOCK}`), `the lane field does not remove the lock on its own: ${result["lane"]}`);
  assert.ok(String(result["lane"]).includes(`it reads ${OWNER_FILE} on its own, removes ${LANE_LOCK} only if`), `the lane field's prose does not say which file its command reads: ${result["lane"]}`);
  assert.ok(String(result["slot"]).includes(`it reads ${SLOT_FILE} on its own, removes ${SLOT_FILE} only if`), `the slot field's prose does not say which file its command reads: ${result["slot"]}`);

  const line = logs.find((l) => l.startsWith("lane 4: REFUSED - "));
  assert.ok(line, `the console never said the release was refused: ${logs.join(" | ")}`);
  assert.ok(line.includes("slot 3: REFUSED - "), `the console line does not carry the slot: ${line}`);
  assert.ok(line.includes("blocked by safety classifier: [Auto-Mode Bypass]"), `a retry that answered nothing dropped what refused the first step: ${line}`);
});

test("the first refusal is logged with its reason before the retry", async () => {
  const { logs, done } = red({ lane: "refused", slot: "refused", notes: "blocked by safety classifier: [Auto-Mode Bypass]" }, GIVEN_BACK);
  const result = await done;
  assert.equal(result["lane"], "released");
  const line = logs.find((l) => l.startsWith("release:zz-aaa1#739: release-lane.sh was refused, retrying as plain commands"));
  assert.ok(line, `nothing was logged about the refusal: ${logs.join(" | ")}`);
  assert.ok(line.includes("blocked by safety classifier: [Auto-Mode Bypass]"), `the log line dropped the reason: ${line}`);

  const silent = red(null, GIVEN_BACK);
  await silent.done;
  assert.ok(silent.logs.some((l) => l.startsWith("release:zz-aaa1#739: release-lane.sh was not answered, retrying as plain commands")), silent.logs.join(" | "));
});

test("a rework retry that is itself refused is REFUSED, and a field the retry did give back is not", async () => {
  const { done } = red(null, { lane: "refused", slot: "released", notes: "the lane command was not permitted" });
  const result = await done;
  assert.match(String(result["lane"]), /^REFUSED - /);
  assert.ok(String(result["lane"]).includes(`rmdir ${LANE_LOCK}`), `with the slot already gone, the lane field must release the lock without going through the slot: ${result["lane"]}`);
  assert.equal(result["slot"], "released");

  const ran = red(null, { lane: "still_held", slot: "refused", notes: "rmdir: directory not empty" });
  const mixed = await ran.done;
  assert.match(String(mixed["lane"]), /^LEAKED - /, "a lock the retry ran against and could not remove is a leak to read, not a refusal");
  assert.match(String(mixed["slot"]), /^REFUSED - /);
});

test("a rework given only a pull request number labels its retry by that number and checks ownership against pr-<n>", async () => {
  const args: Record<string, unknown> = { ...REWORK_ARGS };
  delete args["id"];
  const { calls, done } = runScript("rework.js", args, (call, n) => {
    if (n === 1) return { status: "blocked", notes: "the push was refused" };
    if (call.label === "release:#739") return null;
    if (call.label === "release-retry:#739") return GIVEN_BACK;
    throw new Error(`unexpected step ${call.label}`);
  });
  const result = await done;
  const retry = labelled(calls, "release-retry:#739");
  assert.equal(retry.length, 1, `steps seen: ${calls.map((c) => c.label).join(", ")}`);
  assert.match(retry[0]!.prompt, /= "pr-739" \]; then rm -f/);
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
});

async function plainCommands(prefix: string): Promise<string[]> {
  const { calls, done } = red(null, GIVEN_BACK, { ...REWORK_ARGS, lockPrefix: prefix });
  await done;
  const retry = labelled(calls, "release-retry:zz-aaa1#739")[0];
  assert.ok(retry, "no retry ran");
  const commands = commandsOf(retry.prompt);
  assert.equal(commands.length, 2, `expected two plain commands, found: ${commands.join(" || ")}`);
  return commands;
}

test("a rework's plain commands release what names the run, leave what does not, and say gone the second time", async () => {
  const prefix = `pwrwplain${process.pid}`;
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
    writeFileSync(owner, "zz-aaa1 slot 3 TEST_ENV_NUMBER 4\n");

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
  } finally {
    rmSync(slots, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
    rmSync(owner, { force: true });
  }
});
