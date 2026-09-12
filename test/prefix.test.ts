import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const HARDCODED = ["devloop-merge.lock", "devloop-worktrees", "devloop-slots", "devloop-scratch"];

const LAND_ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockPrefix: "pw",
  repo: "site",
  repos: { site: { path: "cli", slug: "owner/name" } },
};

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { docs: { path: "docs", test: "script/check" } },
};

const TRIAGE_OK = {
  eligible: true,
  repo: "docs",
  title: "a hardcoded prefix",
  priority: 2,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function lockPathIn(prompt: string, where: string): string {
  const found = prompt.match(/\/tmp\/[A-Za-z0-9._-]+-merge\.lock/g) || [];
  const first = found[0];
  assert.ok(first, `${where} names no merge lock at all:\n${prompt}`);
  assert.deepEqual(
    [...new Set(found)],
    [first],
    `${where} names more than one merge lock, so some of its commands act on a lock the rest do not`,
  );
  return first;
}

function promptLabelled(calls: Call[], label: string): string {
  const found = calls.find((c) => c.label === label);
  assert.ok(found, `no ${label} step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found.prompt;
}

type LockSteps = { file: string; lock: string; release: string };

async function landerLockSteps(): Promise<LockSteps[]> {
  const out: LockSteps[] = [];
  for (const file of ["land.js", "land-train.js"]) {
    const { calls, done } = runScript(file, LAND_ARGS, (call, n) => {
      if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
      if (call.label && call.label.startsWith("survey")) return { prs: [] };
      if (call.label === "release") return { status: "released" };
      return { status: "error", notes: "nothing to build" };
    });
    await done;
    const first = calls[0];
    assert.ok(first, `${file} ran no steps at all`);
    out.push({ file, lock: first.prompt, release: promptLabelled(calls, "release") });
  }
  return out;
}

function stepsOf(steps: LockSteps[], file: string): LockSteps {
  const found = steps.find((s) => s.file === file);
  assert.ok(found, `${file} was never run`);
  return found;
}

test("the serial lander and the release train take the same merge lock for one workspace", async () => {
  const steps = await landerLockSteps();
  const serial = lockPathIn(stepsOf(steps, "land.js").lock, "land.js");
  const train = lockPathIn(stepsOf(steps, "land-train.js").lock, "land-train.js");

  assert.equal(
    train,
    serial,
    "land.js and land-train.js took different merge locks for one workspace, so the serial " +
      "lander and the release train do not exclude each other and can merge into the same " +
      "repository at the same time. That is the only thing this lock exists to prevent.",
  );
  assert.equal(serial, "/tmp/pw-merge.lock", "the lock path ignores the workspace's lockPrefix");
});

test("each lander releases the lock it took", async () => {
  const steps = await landerLockSteps();
  for (const { file, lock, release } of steps) {
    assert.equal(
      lockPathIn(release, `${file}'s release step`),
      lockPathIn(lock, `${file}'s lock step`),
      `${file} hands its release step a different lock from the one it took, so the lock it is ` +
        "holding is never given back and the one it removes belongs to somebody else",
    );
  }
});

test("the train builds its worktree under the workspace's own prefix", async () => {
  const { calls, done } = runScript("land-train.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken", token: "land-train-1788964650-29574", holder: "land-train-1788964650-29574" };
    if (call.label === "release") return { status: "released" };
    return { status: "empty", notes: "nothing carries the label" };
  });
  await done;

  assert.match(
    promptLabelled(calls, "build:full"),
    /land-train\.sh .*--prefix pw\b/,
    "the build step never passes the prefix on, so land-train.sh falls back to its default and " +
      "cuts the train worktree under another workspace's directory",
  );
});

test("a lane is told to work under the resolved worktree and scratch roots", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "blocked", summary: "needs a device" };
    return { lane: "released", slot: "released" };
  });
  await done;

  const brief = calls[1];
  assert.ok(brief, "the lane was never briefed");
  assert.match(brief.prompt, /Worktree: \/tmp\/pw-worktrees\/zz-aaa1\b/);
  assert.match(brief.prompt, /Scratch: \/tmp\/pw-scratch\/zz-aaa1\b/);
  assert.match(
    brief.prompt,
    /git worktree add --force \/tmp\/pw-worktrees\/zz-aaa1 /,
    "the brief tells the agent to create a worktree under the default prefix. An agent does what " +
      "the brief says, which is how a directory under another workspace's prefix came to hold " +
      "this one's lanes - a code-only sweep leaves the brief manufacturing that state.",
  );

  const stray = brief.prompt.split("\n").filter((line) => line.includes("/tmp/devloop-"));
  assert.deepEqual(stray, [], `the brief still names the default prefix:\n${stray.join("\n")}`);
});

test("no file in the plugin writes state under a hardcoded prefix", () => {
  const offenders: string[] = [];
  for (const path of filesUnder(SKILL)) {
    const source = readFileSync(path, "utf8");
    for (const literal of HARDCODED) {
      if (source.includes(literal)) offenders.push(`${path.slice(SKILL.length + 1)}: ${literal}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these name a /tmp path under the default prefix rather than the one the workspace " +
      "configures. Every workspace on a machine would share it, including the lane scratch " +
      "directory that two of them have already been writing into at once:\n" +
      offenders.join("\n"),
  );
});
