import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTAKE_LABEL } from "../src/intake.ts";
import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const SCRIPT = join(SKILL, "config.sh");
const SLOT = join(SKILL, "slot.sh");

interface Harness {
  root: string;
  bin: string;
  config: string;
  prefix: string;
  slots: string;
}

let sequence = 0;

function harness(lanes: number): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-dispatch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  const prefix = `pwdispatch${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  writeFileSync(
    config,
    JSON.stringify({
      root,
      idPrefix: "zz",
      lockPrefix: prefix,
      lanes,
      repos: { site: { path: "repo", test: "npm test" } },
    }),
  );
  const bd = join(bin, "bd");
  writeFileSync(bd, "#!/bin/sh\nexit 1\n");
  chmodSync(bd, 0o755);
  return { root, bin, config, prefix, slots: slotsPath(prefix) };
}

function clean(box: Harness): void {
  rmSync(box.slots, { recursive: true, force: true });
  for (let lane = 1; lane <= 9; lane += 1) {
    rmSync(join(LOCK_ROOT, `${box.prefix}-lane-${lane}.lock`), { recursive: true, force: true });
  }
  rmSync(box.root, { recursive: true, force: true });
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function args(box: Harness, ...rest: string[]): Ran {
  return dispatch(box, "--args", ...rest);
}

function rework(box: Harness, ...rest: string[]): Ran {
  return dispatch(box, "--rework", ...rest);
}

function dispatch(box: Harness, mode: string, ...rest: string[]): Ran {
  const ran = spawnSync("bash", [SCRIPT, mode, ...rest], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function slotOf(ran: Ran): number {
  assert.equal(ran.status, 0, ran.stderr);
  return (JSON.parse(ran.stdout) as { slot: number }).slot;
}

function holder(box: Harness, slot: number): string {
  return readFileSync(join(box.slots, String(slot)), "utf8").trim();
}

test("a dispatch reserves the lane it reports", () => {
  const box = harness(2);
  try {
    const ran = args(box, "zz-aaa1");
    assert.equal(slotOf(ran), 1);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("every dispatch mints its own token, so a retry can tell its lock from a second dispatch's", () => {
  const box = harness(2);
  try {
    const first = args(box, "zz-aaa1");
    const second = args(box, "zz-aaa1");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const a = (JSON.parse(first.stdout) as { dispatch: string }).dispatch;
    const b = (JSON.parse(second.stdout) as { dispatch: string }).dispatch;
    assert.match(a, /^[0-9a-f]{16}$/, `the dispatch token is not a hex string: ${a}`);
    assert.match(b, /^[0-9a-f]{16}$/, `the dispatch token is not a hex string: ${b}`);
    assert.notEqual(a, b, "two dispatches of one issue share a token, so a duplicate dispatch would reclaim the first one's lane");
  } finally {
    clean(box);
  }
});

test("dispatching the same issue twice hands back the one reservation", () => {
  const box = harness(2);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    assert.ok(!existsSync(join(box.slots, "2")));
  } finally {
    clean(box);
  }
});

test("a lane number that disagrees with the reservation is refused", () => {
  const box = harness(2);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    const ran = args(box, "zz-aaa1", "5");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /holds slot 1, not 5/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("the lane number the reservation already names is accepted", () => {
  const box = harness(2);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    assert.equal(slotOf(args(box, "zz-aaa1", "1")), 1);
  } finally {
    clean(box);
  }
});

test("a locked lane is never handed to a dispatch", () => {
  const box = harness(2);
  try {
    mkdirSync(join(LOCK_ROOT, `${box.prefix}-lane-2.lock`), { recursive: true });
    assert.equal(slotOf(args(box, "zz-bbb1")), 2);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a full pool stops the dispatch instead of printing a guessed lane", () => {
  const box = harness(1);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    const ran = args(box, "zz-bbb1");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /dispatch stops/);
  } finally {
    clean(box);
  }
});

interface Rework {
  id: string;
  pr: number;
  repo: string;
  slot: number;
  scriptPath: string;
  skillDir: string;
  root: string;
}

function reworkOf(ran: Ran): Rework {
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout) as Rework;
}

test("a rework dispatch reserves the lane it reports and carries the pull request", () => {
  const box = harness(2);
  try {
    const built = reworkOf(rework(box, "zz-aaa1", "739", "site"));
    assert.equal(built.slot, 1);
    assert.equal(holder(box, 1), "zz-aaa1");
    assert.equal(built.id, "zz-aaa1");
    assert.equal(built.pr, 739);
    assert.equal(built.repo, "site");
    assert.equal(built.root, box.root);
    assert.match(built.scriptPath, /\/rework\.js$/);
    assert.ok(existsSync(built.scriptPath), "the staged rework.js is not where scriptPath says");
    assert.ok(existsSync(join(built.skillDir, "release-lane.sh")));
  } finally {
    clean(box);
  }
});

test("reworking the same issue twice hands back the one reservation", () => {
  const box = harness(2);
  try {
    assert.equal(reworkOf(rework(box, "zz-aaa1", "739", "site")).slot, 1);
    assert.equal(reworkOf(rework(box, "zz-aaa1", "739", "site")).slot, 1);
    assert.ok(!existsSync(join(box.slots, "2")));
  } finally {
    clean(box);
  }
});

test("a rework dispatch takes no slot from the caller", () => {
  const box = harness(2);
  try {
    const ran = rework(box, "zz-aaa1", "739", "site", "2");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /usage: config.sh --rework/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a rework for a repository the config does not name reserves nothing", () => {
  const box = harness(2);
  try {
    const ran = rework(box, "zz-aaa1", "739", "extension");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /no repository extension/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a rework whose pull request is not a number reserves nothing", () => {
  const box = harness(2);
  try {
    const ran = rework(box, "zz-aaa1", "#739", "site");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /pull request must be a number/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a locked lane is never handed to a rework", () => {
  const box = harness(2);
  try {
    mkdirSync(join(LOCK_ROOT, `${box.prefix}-lane-2.lock`), { recursive: true });
    assert.equal(reworkOf(rework(box, "zz-bbb1", "740", "site")).slot, 2);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a full pool stops the rework instead of printing a guessed lane", () => {
  const box = harness(1);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    const ran = rework(box, "zz-bbb1", "740", "site");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /dispatch stops/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

interface Harness2 extends Harness {
  wf: string;
  tasks: string;
}

interface Run {
  task: string;
  run: string;
  labels?: readonly string[];
  result?: string;
}

function lanes(box: Harness, runs: readonly Run[]): Harness2 {
  const wf = join(box.root, "projects");
  const tasks = join(box.root, "tasks");
  mkdirSync(wf, { recursive: true });
  mkdirSync(tasks, { recursive: true });
  const transcript: string[] = [];
  for (const run of runs) {
    writeFileSync(join(tasks, `${run.task}.output`), run.result ?? "");
    transcript.push(
      JSON.stringify({
        type: "user",
        toolUseResult: {
          status: "async_launched",
          taskId: run.task,
          taskType: "local_workflow",
          workflowName: "devloop-task",
          runId: run.run,
          scriptPath: "/w/.autofix-run/task.js",
        },
      }),
    );
    const dir = join(wf, "session-1", "subagents", "workflows", run.run);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "launched" }),
      ...(run.labels ?? []).map((label) => JSON.stringify({ type: "started", agentId: "a1", label, phase: "Fix" })),
    ];
    writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
    const old = new Date(Date.now() - 90 * 60_000);
    utimesSync(join(dir, "journal.jsonl"), old, old);
    utimesSync(dir, old, old);
  }
  writeFileSync(join(wf, "session-1.jsonl"), `${transcript.join("\n")}\n`);
  return { ...box, wf, tasks };
}

function slot(box: Harness2, ...rest: string[]): Ran {
  const ran = spawnSync("bash", [SLOT, ...rest], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      DEVLOOP_ROOT: box.root,
      DEVLOOP_WF: box.wf,
      DEVLOOP_TASKS: box.tasks,
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function reserve(box: Harness, n: number, id: string, minutesAgo = 0): void {
  mkdirSync(box.slots, { recursive: true });
  writeFileSync(join(box.slots, String(n)), `${id}\n`);
  if (minutesAgo > 0) {
    const then = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(join(box.slots, String(n)), then, then);
  }
}

test("a full pool never lists a lock-less slot as finished or suggests --gc", () => {
  const box = lanes(harness(1), []);
  try {
    reserve(box, 1, "zz-aaa1");
    const ran = slot(box, "zz-bbb1");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /^all 1 lanes busy\n/);
    assert.doesNotMatch(ran.stderr, /--gc/, "a destructive command is reached for deliberately, not suggested");
    assert.doesNotMatch(ran.stderr, /probably finished/);
    assert.doesNotMatch(ran.stderr, /zz-aaa1/, "an absent lock is no evidence about the holder");
    assert.match(ran.stderr, /slot\.sh --release <id>/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("a full pool whose every slot holds its lane lock prints the one line it always did", () => {
  const box = lanes(harness(1), []);
  try {
    reserve(box, 1, "zz-aaa1");
    mkdirSync(join(LOCK_ROOT, `${box.prefix}-lane-2.lock`), { recursive: true });
    const ran = slot(box, "zz-bbb1");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stderr, "all 1 lanes busy\n");
  } finally {
    clean(box);
  }
});

test("--gc keeps a slot reserved seconds ago, whatever else is true of it", () => {
  const box = lanes(harness(2), []);
  try {
    reserve(box, 1, "zz-aaa1");
    const ran = slot(box, "--gc");
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /keeping slot 1 \(zz-aaa1\): reserved in the last 30 minutes/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("--gc keeps a slot whose lane a task in flight is running, though it holds no lane lock", () => {
  const box = lanes(harness(2), [{ task: "w111", run: "wf_aaa", labels: ["fix:zz-aaa1"] }]);
  try {
    reserve(box, 1, "zz-aaa1", 45);
    const ran = slot(box, "--gc");
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /keeping slot 1 \(zz-aaa1\): a task for it is in flight/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("--gc keeps a slot when nothing can say whether its lane is running", () => {
  const box = lanes(harness(2), []);
  try {
    rmSync(box.tasks, { recursive: true, force: true });
    reserve(box, 1, "zz-aaa1", 45);
    const ran = slot(box, "--gc");
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /keeping slot 1 \(zz-aaa1\): UNKNOWN - cannot establish/);
    assert.doesNotMatch(ran.stdout, /freeing/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("--gc frees a slot only when its lane is positively not running, and says what it read", () => {
  const box = lanes(harness(2), [{ task: "w111", run: "wf_aaa", labels: ["fix:zz-aaa1"], result: "zz-aaa1 verified\n" }]);
  try {
    reserve(box, 1, "zz-aaa1", 45);
    const ran = slot(box, "--gc");
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /freeing slot 1 \(zz-aaa1\): lane-running\.sh reports NOT-RUNNING/);
    assert.doesNotMatch(ran.stdout, /no lane lock/, "the free names the verdict, not the absence of a lock");
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

function tracked(box: Harness, issues: Record<string, { labels: readonly string[] }>, actor?: string): void {
  const config = JSON.parse(readFileSync(box.config, "utf8")) as Record<string, unknown>;
  if (actor) config["actor"] = actor;
  else delete config["actor"];
  writeFileSync(box.config, JSON.stringify(config));
  const cases = Object.entries(issues)
    .map(([id, issue]) => `  "show ${id} --json") echo '${JSON.stringify({ id, labels: issue.labels })}' ;;`)
    .join("\n");
  writeFileSync(
    join(box.bin, "bd"),
    ["#!/bin/sh", 'case "$*" in', cases, "  *) exit 1 ;;", "esac", ""].join("\n"),
  );
  chmodSync(join(box.bin, "bd"), 0o755);
}

function refine(box: Harness, ...rest: string[]): Ran {
  return dispatch(box, "--refine", ...rest);
}

interface Refine {
  id: string;
  slot: number;
  actor: string;
  scriptPath: string;
  skillDir: string;
  root: string;
  repos: Record<string, unknown>;
}

test("a refine dispatch reserves the lane it reports and carries the actor every tracker write needs", () => {
  const box = harness(2);
  try {
    tracked(box, { "zz-req1": { labels: [INTAKE_LABEL] } }, "zz-devloop");
    const ran = refine(box, "zz-req1");
    assert.equal(ran.status, 0, ran.stderr);
    const built = JSON.parse(ran.stdout) as Refine;
    assert.equal(built.id, "zz-req1");
    assert.equal(built.slot, 1);
    assert.equal(holder(box, 1), "zz-req1");
    assert.equal(built.actor, "zz-devloop");
    assert.equal(built.root, box.root);
    assert.match(built.scriptPath, /\/refine\.js$/);
    assert.ok(existsSync(built.scriptPath), "the staged refine.js is not where scriptPath says");
    assert.ok(existsSync(join(built.skillDir, "WRITING-TICKETS.md")), "skillDir does not hold the standard the run is pointed at");
    assert.ok("site" in built.repos);
  } finally {
    clean(box);
  }
});

test("a refine dispatch takes no slot from the caller", () => {
  const box = harness(2);
  try {
    tracked(box, { "zz-req1": { labels: [INTAKE_LABEL] } }, "zz-devloop");
    const ran = refine(box, "zz-req1", "2");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /usage: config.sh --refine/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a workspace that declares no actor cannot dispatch a refine, and reserves nothing finding out", () => {
  const box = harness(2);
  try {
    tracked(box, { "zz-req1": { labels: [INTAKE_LABEL] } });
    const ran = refine(box, "zz-req1");
    assert.equal(ran.status, 2);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /declares no usable "actor"/);
    assert.match(ran.stderr, /"actor": "<project>-devloop"/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("an issue without the intake label is not refined, and the refusal names the door it should take", () => {
  const box = harness(2);
  try {
    tracked(box, { "zz-tkt1": { labels: ["needs-tests"] } }, "zz-devloop");
    const ran = refine(box, "zz-tkt1");
    assert.equal(ran.status, 1);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, new RegExp(`does not carry the '${INTAKE_LABEL}' label`));
    assert.match(ran.stderr, /config.sh --args zz-tkt1/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a task dispatch refuses an unrefined request and prints the refine command instead", () => {
  const box = harness(2);
  try {
    tracked(box, { "zz-req1": { labels: [INTAKE_LABEL] } }, "zz-devloop");
    const ran = args(box, "zz-req1");
    assert.equal(ran.status, 1);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /has not been refined, not a task/);
    assert.match(ran.stderr, /config.sh --refine zz-req1/);
    assert.ok(!existsSync(join(box.slots, "1")), "a lane was reserved for a request no lane can start from");
  } finally {
    clean(box);
  }
});
