import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV } from "./support/git.js";

const SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
);

type Flight = "lane" | "lander" | "unattributable" | "nothing";

interface Workspace {
  root: string;
  wf: string;
  tasks: string;
}

function workspace(flight: Flight): Workspace {
  const root = mkdtempSync(join(tmpdir(), "pitwall-queue-watch-"));
  const wf = join(root, "projects");
  const tasks = join(root, "tasks");
  mkdirSync(wf, { recursive: true });
  mkdirSync(tasks, { recursive: true });

  if (flight === "nothing") {
    writeFileSync(join(tasks, "w111.output"), "done\n");
    writeFileSync(join(wf, "session-1.jsonl"), "");
    return { root, wf, tasks };
  }

  writeFileSync(join(tasks, "w111.output"), "");
  if (flight === "unattributable") {
    writeFileSync(join(wf, "session-1.jsonl"), "");
    return { root, wf, tasks };
  }

  const run = "wf_aaa";
  const script = flight === "lander" ? "land.js" : "task.js";
  const label = flight === "lander" ? "land:site#61" : "fix:pitwall-90b";
  const dir = join(wf, "session-1", "subagents", "workflows", run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "journal.jsonl"),
    `${[
      JSON.stringify({ type: "launched" }),
      JSON.stringify({ type: "started", agentId: "a1", label, phase: "Fix" }),
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(wf, "session-1.jsonl"),
    `${JSON.stringify({
      type: "user",
      toolUseResult: {
        status: "async_launched",
        taskId: "w111",
        taskType: "local_workflow",
        workflowName: "devloop-task",
        runId: run,
        summary: "Carry one tracker issue from open to landable",
        scriptPath: `/w/.autofix-run/${script}`,
      },
    })}\n`,
  );
  return { root, wf, tasks };
}

interface Dispatch {
  task: string;
  run: string;
  minutesAgo: number;
  label?: string;
  unmeasurable?: boolean;
}

function dispatches(runs: readonly Dispatch[]): Workspace {
  const root = mkdtempSync(join(tmpdir(), "pitwall-queue-watch-"));
  const wf = join(root, "projects");
  const tasks = join(root, "tasks");
  mkdirSync(wf, { recursive: true });
  mkdirSync(tasks, { recursive: true });

  const records: string[] = [];
  for (const dispatch of runs) {
    writeFileSync(join(tasks, `${dispatch.task}.output`), "");
    const dir = join(wf, "session-1", "subagents", "workflows", dispatch.run);
    mkdirSync(dir, { recursive: true });
    const journal = join(dir, "journal.jsonl");
    writeFileSync(
      journal,
      `${[
        JSON.stringify({ type: "launched" }),
        JSON.stringify({
          type: "started",
          agentId: "a1",
          label: dispatch.label ?? "fix:pitwall-azp",
          phase: "Fix",
        }),
      ].join("\n")}\n`,
    );
    const when = new Date(Date.now() - dispatch.minutesAgo * 60_000);
    utimesSync(journal, when, when);
    records.push(
      JSON.stringify({
        type: "user",
        toolUseResult: {
          status: "async_launched",
          taskId: dispatch.task,
          taskType: "local_workflow",
          workflowName: "devloop-task",
          runId: dispatch.run,
          summary: "Carry one tracker issue from open to landable",
          scriptPath: "/w/.autofix-run/task.js",
        },
      }),
    );
  }
  writeFileSync(join(wf, "session-1.jsonl"), `${records.join("\n")}\n`);
  for (const dispatch of runs) {
    if (!dispatch.unmeasurable) continue;
    chmodSync(join(wf, "session-1", "subagents", "workflows", dispatch.run), 0o111);
  }
  return { root, wf, tasks };
}

function readable(space: Workspace, runs: readonly Dispatch[]): void {
  for (const dispatch of runs) {
    if (!dispatch.unmeasurable) continue;
    chmodSync(join(space.wf, "session-1", "subagents", "workflows", dispatch.run), 0o755);
  }
}

function shellFunction(name: string): string {
  const source = readFileSync(join(SKILL, "queue-watch.sh"), "utf8");
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} moved - update this test rather than deleting it`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return source.slice(start, end + 2);
}

function silence(space: Workspace, minutesAgo: number): void {
  const when = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(
    join(space.wf, "session-1", "subagents", "workflows", "wf_aaa", "journal.jsonl"),
    when,
    when,
  );
}

function run(space: Workspace, lines: readonly string[]): string {
  const driver = [...lines, ""].join("\n");
  const ran = spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: space.root,
      DEVLOOP_WF: space.wf,
      DEVLOOP_TASKS: space.tasks,
    },
  });
  return `${ran.stdout ?? ""}`.trim();
}

function lanesBusy(space: Workspace): string {
  return run(space, [`skill=${JSON.stringify(SKILL)}`, shellFunction("lanes_busy"), "lanes_busy"]);
}

function landGate(space: Workspace, ready: string): string {
  return run(space, [
    `skill=${JSON.stringify(SKILL)}`,
    `PFX=pitwall-queue-watch-test-${process.pid}`,
    'prev_ready=""',
    'prev_blind=""',
    'prev_silent=""',
    shellFunction("lanes_busy"),
    shellFunction("silent_lanes"),
    shellFunction("lander_running"),
    shellFunction("land_gate"),
    `land_gate ${JSON.stringify(ready)} "$(lanes_busy)"`,
  ]);
}

function landGateAcrossTicks(space: Workspace, ready: string): { first: string; second: string } {
  const journal = join(space.wf, "session-1", "subagents", "workflows", "wf_aaa", "journal.jsonl");
  const out = run(space, [
    `skill=${JSON.stringify(SKILL)}`,
    `PFX=pitwall-queue-watch-test-${process.pid}`,
    'prev_ready=""',
    'prev_blind=""',
    'prev_silent=""',
    shellFunction("lanes_busy"),
    shellFunction("silent_lanes"),
    shellFunction("lander_running"),
    shellFunction("land_gate"),
    `land_gate ${JSON.stringify(ready)} "$(lanes_busy)"`,
    "echo __TICK__",
    `touch -t 202001010000 ${JSON.stringify(journal)}`,
    `land_gate ${JSON.stringify(ready)} "$(lanes_busy)"`,
  ]);
  const [first, second] = out.split("__TICK__");
  return { first: (first ?? "").trim(), second: (second ?? "").trim() };
}

test("the supervisor's land gate is not 0 while a lane is in flight", () => {
  assert.equal(lanesBusy(workspace("lane")), "RUNNING");
});

test("the supervisor's land gate is not 0 when the answer cannot be established", () => {
  assert.equal(lanesBusy(workspace("unattributable")), "UNKNOWN");
});

test("the supervisor's land gate is 0 when only a lander is in flight", () => {
  assert.equal(lanesBusy(workspace("lander")), "0");
});

test("the supervisor's land gate is 0 when every run has written its result", () => {
  assert.equal(lanesBusy(workspace("nothing")), "0");
});

test("the land gate says so when the lane holding it shut has gone silent", () => {
  const space = workspace("lane");
  silence(space, 720);
  const out = landGate(space, "site#61");
  assert.match(out, /gone silent - site#61/);
  assert.match(out, /journal silent 7[0-9][0-9]m/);
  assert.match(out, /w111/);
  assert.match(out, /wf_aaa/);
  assert.match(out, /gate stays shut/);
});

test("a lane dispatched once and gone silent is reported without a withheld-dispatch trailer", () => {
  const space = workspace("lane");
  silence(space, 92);
  const out = landGate(space, "site#61");
  assert.match(out, /journal silent 9[0-9]m/);
  assert.doesNotMatch(out, /newest of/);
  assert.doesNotMatch(out, /earlier dispatch/);
});

test("the land gate stays quiet while the lane holding it shut is still writing", () => {
  assert.equal(landGate(workspace("lane"), "site#61"), "");
});

test("a lane that goes silent after the gate has already seen that ready set is still announced", () => {
  const { first, second } = landGateAcrossTicks(workspace("lane"), "site#61");
  assert.equal(first, "");
  assert.match(second, /gone silent - site#61/);
  assert.match(second, /w111/);
});

test("the land gate announces work ready to land when no lane is running", () => {
  assert.match(landGate(workspace("nothing"), "site#61"), /^QUEUE: ready to land, no lanes running - site#61$/);
});

test("an issue re-dispatched twice is not silent while its newest run is writing", () => {
  const space = dispatches([
    { task: "w111", run: "wf_f80fcf95", minutesAgo: 93 },
    { task: "w222", run: "wf_12c0c01f", minutesAgo: 92 },
    { task: "w333", run: "wf_92bb050e", minutesAgo: 0 },
  ]);
  assert.equal(landGate(space, "site#80"), "");
});

test("an issue whose newest run is also silent is reported, naming that run and no other", () => {
  const space = dispatches([
    { task: "w111", run: "wf_f80fcf95", minutesAgo: 93 },
    { task: "w222", run: "wf_12c0c01f", minutesAgo: 92 },
    { task: "w333", run: "wf_92bb050e", minutesAgo: 30 },
  ]);
  const out = landGate(space, "site#80");
  assert.match(out, /gone silent - site#80/);
  assert.match(out, /task w333, workflow wf_92bb050e/);
  assert.match(out, /journal silent (29|30|31)m/);
  assert.match(out, /, newest of 3$/m);
  assert.match(out, /An earlier dispatch says nothing about the issue/);
  assert.doesNotMatch(out, /wf_f80fcf95/);
  assert.doesNotMatch(out, /wf_12c0c01f/);
  assert.equal(out.split("\n").filter((line) => line.includes("task w")).length, 1);
});

test("a run whose labels carry no issue id is judged alone, not against another such run", () => {
  const space = dispatches([
    { task: "w111", run: "wf_one", minutesAgo: 93, label: "Fix" },
    { task: "w222", run: "wf_two", minutesAgo: 0, label: "Fix" },
  ]);
  const out = landGate(space, "site#80");
  assert.match(out, /task w111, workflow wf_one/);
  assert.doesNotMatch(out, /wf_two/);
  assert.doesNotMatch(out, /newest of/);
});

const AS_ROOT = process.getuid?.() === 0;
const ROOT_SKIP = AS_ROOT
  ? "root reads a directory whatever its mode, so no journal age can be made unmeasurable"
  : false;

test(
  "a run whose age cannot be measured does not settle the issue for the run whose age can",
  { skip: ROOT_SKIP },
  () => {
    const runs: readonly Dispatch[] = [
      { task: "w111", run: "wf_f80fcf95", minutesAgo: 93 },
      { task: "w222", run: "wf_92bb050e", minutesAgo: 0, unmeasurable: true },
    ];
    const space = dispatches(runs);
    try {
      const out = landGate(space, "site#80");
      assert.match(out, /gone silent - site#80/);
      assert.match(out, /task w111, workflow wf_f80fcf95/);
      assert.match(out, /journal silent 9[0-9]m/);
      assert.match(out, /, newest of 2$/m);
      assert.doesNotMatch(out, /wf_92bb050e/);
    } finally {
      readable(space, runs);
    }
  },
);

test(
  "a lane whose age cannot be measured is not reported as silent either",
  { skip: ROOT_SKIP },
  () => {
    const runs: readonly Dispatch[] = [
      { task: "w111", run: "wf_92bb050e", minutesAgo: 0, unmeasurable: true },
    ];
    const space = dispatches(runs);
    try {
      assert.equal(landGate(space, "site#80"), "");
    } finally {
      readable(space, runs);
    }
  },
);

test("the land gate announces that it cannot tell whether a lane is running", () => {
  const out = landGate(workspace("unattributable"), "site#61");
  assert.match(out, /cannot be established - site#61/);
  assert.match(out, /not 'no lanes running'/);
});

interface Prefixed {
  idPrefix?: string;
  dispatchable: string;
  stuck: string;
  ack?: string;
}

function prefixedWorkspace(shape: Prefixed): { root: string; skill: string } {
  const root = mkdtempSync(join(tmpdir(), "pitwall-queue-watch-prefix-"));
  const skill = join(root, "skill");
  const bin = join(root, "bin");
  mkdirSync(skill);
  mkdirSync(bin);
  writeFileSync(join(skill, "queue-watch.sh"), readFileSync(join(SKILL, "queue-watch.sh"), "utf8"));
  const idPrefix = shape.idPrefix === undefined ? "exit 1" : `echo ${JSON.stringify(shape.idPrefix)}`;
  writeFileSync(
    join(skill, "config.sh"),
    [
      "#!/bin/bash",
      'case "${1:-}" in',
      `  idPrefix) ${idPrefix} ;;`,
      `  lockPrefix) echo pitwall-queue-watch-test-${process.pid} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  for (const [name, text] of [
    ["dispatchable", shape.dispatchable],
    ["triage-scan", shape.stuck],
  ] as const) {
    writeFileSync(join(skill, `${name}.txt`), `${text}\n`);
    writeFileSync(join(skill, `${name}.sh`), `#!/bin/bash\ncat "$(dirname "$0")/${name}.txt"\n`);
  }
  writeFileSync(join(skill, "lane-running.sh"), "#!/bin/bash\nexit 1\n");
  writeFileSync(join(bin, "sleep"), "#!/bin/bash\nkill $PPID\n");
  chmodSync(join(bin, "sleep"), 0o755);
  if (shape.ack !== undefined) writeFileSync(join(root, ".devloop-triage-ack"), shape.ack);
  return { root, skill };
}

function oneTick(space: { root: string; skill: string }): { stdout: string; stderr: string; status: number | null } {
  const ran = spawnSync("bash", [join(space.skill, "queue-watch.sh"), "--root", space.root, "--interval", "300"], {
    encoding: "utf8",
    cwd: space.root,
    timeout: 20_000,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${join(space.root, "bin")}:${process.env.PATH ?? ""}`,
    },
  });
  return { stdout: `${ran.stdout ?? ""}`.trim(), stderr: `${ran.stderr ?? ""}`.trim(), status: ran.status };
}

test("new work is announced under the workspace's own id prefix", () => {
  const out = oneTick(
    prefixedWorkspace({
      idPrefix: "pitwall",
      dispatchable: "pitwall-76x        P2  queue-watch.sh cannot see new work\npitwall-4b5.1  P3  a child",
      stuck: "",
    }),
  );
  assert.match(out.stdout, /^QUEUE: new work ready to dispatch - pitwall-4b5\.1 pitwall-76x$/m);
});

test("a triage finding is announced under the workspace's own id prefix", () => {
  const out = oneTick(
    prefixedWorkspace({
      idPrefix: "pitwall",
      dispatchable: "(nothing dispatchable - every ready issue is parked, an epic, or a parent)",
      stuck: "STUCK: parked with no reason\n  pitwall-90b  needs-decision and no note\n  site#61  a labelled pull request",
    }),
  );
  assert.match(out.stdout, /^QUEUE: triage found something stuck - pitwall-90b site#61$/m);
  assert.match(out.stdout, /pitwall-90b  needs-decision and no note/);
  assert.doesNotMatch(out.stdout, /new work ready/);
});

test("an adjudicated finding under the workspace's own id prefix is suppressed, not re-announced", () => {
  const out = oneTick(
    prefixedWorkspace({
      idPrefix: "pitwall",
      dispatchable: "",
      stuck: "STUCK: parked with no reason\n  pitwall-90b  needs-decision and no note\n  pitwall-76x  needs-access and no note",
      ack: "pitwall-90b adjudicated 2026-09-11\n",
    }),
  );
  assert.match(out.stdout, /^QUEUE: triage found something stuck - pitwall-76x$/m);
  assert.match(out.stdout, /1 known finding\(s\) suppressed, already adjudicated: pitwall-90b/);
});

test("the watcher refuses to start when the id prefix cannot be resolved", () => {
  const out = oneTick(
    prefixedWorkspace({
      dispatchable: "pitwall-76x        P2  queue-watch.sh cannot see new work",
      stuck: "STUCK: parked with no reason\n  pitwall-90b  needs-decision and no note",
    }),
  );
  assert.equal(out.status, 3);
  assert.match(out.stderr, /idPrefix/);
  assert.equal(out.stdout, "");
});
