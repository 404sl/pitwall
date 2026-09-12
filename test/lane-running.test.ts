import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV } from "./support/git.js";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "lane-running.sh",
);

interface Dispatch {
  task: string;
  run?: string;
  labels?: readonly string[];
  journal?: readonly string[];
  result?: string;
  runs?: readonly string[];
  script?: string | null;
}

interface Workspace {
  root: string;
  wf: string;
  tasks: string;
}

function workspace(dispatches: readonly Dispatch[]): Workspace {
  const root = mkdtempSync(join(tmpdir(), "pitwall-lane-running-"));
  const wf = join(root, "projects");
  const tasks = join(root, "tasks");
  mkdirSync(wf, { recursive: true });
  mkdirSync(tasks, { recursive: true });

  const transcript: string[] = [];
  for (const dispatch of dispatches) {
    writeFileSync(join(tasks, `${dispatch.task}.output`), dispatch.result ?? "");
    for (const run of dispatch.runs ?? (dispatch.run === undefined ? [] : [dispatch.run])) {
      const script = dispatch.script === undefined ? "task.js" : dispatch.script;
      transcript.push(
        JSON.stringify({
          type: "user",
          toolUseResult: {
            status: "async_launched",
            taskId: dispatch.task,
            taskType: "local_workflow",
            workflowName: "devloop-task",
            runId: run,
            summary: "Carry one tracker issue from open to landable",
            ...(script === null ? {} : { scriptPath: `/w/.autofix-run/${script}` }),
          },
        }),
      );
      const dir = join(wf, "session-1", "subagents", "workflows", run);
      mkdirSync(dir, { recursive: true });
      const lines = [
        JSON.stringify({ type: "launched" }),
        ...(dispatch.labels ?? []).map((label) =>
          JSON.stringify({ type: "started", agentId: "a1", label, phase: "Fix" }),
        ),
        ...(dispatch.journal ?? []).map((text) =>
          JSON.stringify({ type: "result", agentId: "a1", result: { summary: text } }),
        ),
      ];
      writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
    }
  }
  writeFileSync(join(wf, "session-1.jsonl"), `${transcript.join("\n")}\n`);
  return { root, wf, tasks };
}

function ask(
  space: Workspace,
  id: string,
  args: readonly string[] = [],
  tasks?: string,
): { status: number; out: string } {
  const ran = spawnSync("bash", [SCRIPT, ...args, id], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: space.root,
      DEVLOOP_WF: space.wf,
      DEVLOOP_TASKS: tasks ?? space.tasks,
    },
  });
  return { status: ran.status ?? -1, out: `${ran.stdout}${ran.stderr}` };
}

function askAny(
  space: Workspace,
  args: readonly string[] = [],
  tasks?: string,
): { status: number; out: string } {
  const ran = spawnSync("bash", [SCRIPT, "--any", ...args], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: space.root,
      DEVLOOP_WF: space.wf,
      DEVLOOP_TASKS: tasks ?? space.tasks,
    },
  });
  return { status: ran.status ?? -1, out: `${ran.stdout}${ran.stderr}` };
}

test("a task whose result is not written yet is RUNNING for the issue its journal labels", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["triage:pitwall-90b", "fix:pitwall-90b"] }]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
  assert.match(out, /w111/);
  assert.match(out, /wf_aaa/);
});

test("a written result is a finished run, not a live lane", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"], result: "pitwall-90b landed\n" }]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
  assert.match(out, /1 finished run/);
});

test("a lander that only MENTIONS the id is not this issue's lane", () => {
  const space = workspace([
    {
      task: "w111",
      run: "wf_land",
      script: "land.js",
      labels: ["land:site#61"],
      journal: ["merged devloop/pitwall-90b at dc75584"],
    },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
  assert.match(out, /1 lander\(s\) in flight/);
});

test("a rework lane labelled only by its pull request is UNKNOWN, never NOT-RUNNING", () => {
  const space = workspace([
    { task: "w111", run: "wf_rw", script: "rework.js", labels: ["resolve:#739"] },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.notEqual(status, 1, out);
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
  assert.match(out, /w111/);
});

test("a rework lane labelled with the id and its pull request is RUNNING", () => {
  const space = workspace([
    { task: "w111", run: "wf_rw", script: "rework.js", labels: ["resolve:pitwall-90b#739"] },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
});

test("a rework lane labelled with ANOTHER id belongs to that issue, not to this one", () => {
  const space = workspace([
    { task: "w111", run: "wf_rw", script: "rework.js", labels: ["resolve:pitwall-AAA#100"] },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
  assert.match(out, /1 lane\(s\) in flight belong to other issues/);
});

test("a rework that has reached its release step still belongs to the id its labels carry", () => {
  const space = workspace([
    {
      task: "w111",
      run: "wf_rw",
      script: "rework.js",
      labels: ["resolve:pitwall-AAA#100", "handoff:pitwall-AAA#100", "release:pitwall-AAA#100"],
    },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
  assert.match(out, /1 lane\(s\) in flight belong to other issues/);
});

test("a retried phase numbered after the id is still this lane", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b#2"] }]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
});

test("a dispatch that does not say which script it ran is UNKNOWN", () => {
  const space = workspace([
    { task: "w111", run: "wf_aaa", script: null, labels: ["fix:pitwall-other"] },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
});

test("a running child does not make its parent id running", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-4b5.1"] }]);
  const { status, out } = ask(space, "pitwall-4b5");
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /^RUNNING/);
});

test("a task in flight that cannot be attributed is UNKNOWN and names itself", () => {
  const space = workspace([{ task: "w111" }]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
  assert.match(out, /w111/);
  assert.match(out, /Not evidence it is dead/);
});

test("a task in flight whose journal has no labels yet is UNKNOWN", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa" }]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
});

test("a task in flight claimed by two workflows is UNKNOWN, not attributed to one of them", () => {
  const space = workspace([
    { task: "w111", runs: ["wf_aaa", "wf_bbb"], labels: ["fix:pitwall-90b"] },
  ]);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
});

test("no task directory for the workspace is UNKNOWN, never NOT-RUNNING", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const { status, out } = ask(space, "pitwall-90b", [], join(space.root, "no-such-session"));
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
  assert.match(out, /no task directory/);
});

test("--quiet prints one machine-readable verdict", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const running = ask(space, "pitwall-90b", ["--quiet"]);
  assert.equal(running.out.trim(), "RUNNING");
  const other = ask(space, "pitwall-zzzz", ["--quiet"]);
  assert.equal(other.out.trim(), "NOT-RUNNING");
});

test("an unresolvable workspace exits 3 rather than answering", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const ran = spawnSync("bash", [SCRIPT, "pitwall-90b"], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: "",
      PITWALL_CONFIG: "",
      DEVLOOP_CONFIG: "",
      HOME: space.root,
    },
  });
  assert.equal(ran.status, 3, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stderr, /refusing to guess/);
});

test("--any is RUNNING while a lane for any other issue is in flight", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-AAA"] }]);
  const { status, out } = askAny(space);
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
  assert.match(out, /pitwall-AAA/);
  assert.match(out, /w111/);
});

test("--any counts a rework lane labelled only by its pull request as a lane", () => {
  const space = workspace([
    { task: "w111", run: "wf_rw", script: "rework.js", labels: ["resolve:#739"] },
  ]);
  const { status, out } = askAny(space);
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
  assert.match(out, /no id in its labels/);
});

test("--any is NOT-RUNNING when only a lander is in flight", () => {
  const space = workspace([
    {
      task: "w111",
      run: "wf_land",
      script: "land.js",
      labels: ["land:site#61"],
      journal: ["merged devloop/pitwall-90b at dc75584"],
    },
  ]);
  const { status, out } = askAny(space);
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
  assert.match(out, /1 lander\(s\) in flight/);
});

test("--any is NOT-RUNNING when every run has written its result", () => {
  const space = workspace([
    { task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"], result: "pitwall-90b landed\n" },
  ]);
  const { status, out } = askAny(space);
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
});

test("--any is UNKNOWN while a task in flight cannot be attributed", () => {
  const space = workspace([{ task: "w111" }]);
  const { status, out } = askAny(space);
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
  assert.match(out, /w111/);
  assert.match(out, /not 'no lanes running'/);
});

test("--any with no task directory is UNKNOWN, never NOT-RUNNING", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const { status, out } = askAny(space, [], join(space.root, "no-such-session"));
  assert.equal(status, 2, out);
  assert.match(out, /^UNKNOWN/);
  assert.match(out, /no task directory/);
});

test("--any answers about every lane, so an issue id with it is an error", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const { status, out } = askAny(space, ["pitwall-90b"]);
  assert.equal(status, 6, out);
  assert.match(out, /takes no issue id/);
});

test("--any --quiet prints one machine-readable verdict", () => {
  const running = askAny(workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]), ["--quiet"]);
  assert.equal(running.out.trim(), "RUNNING");
  const idle = askAny(workspace([{ task: "w111", result: "done\n" }]), ["--quiet"]);
  assert.equal(idle.out.trim(), "NOT-RUNNING");
});

function silence(space: Workspace, run: string, minutesAgo: number): void {
  const when = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(join(space.wf, "session-1", "subagents", "workflows", run, "journal.jsonl"), when, when);
}

test("a RUNNING lane whose journal stopped moving is still RUNNING, and says for how long", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  silence(space, "wf_aaa", 720);
  const { status, out } = ask(space, "pitwall-90b");
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
  assert.match(out, /journal silent 7[0-9][0-9]m/);
  assert.match(out, /w111/);
  assert.match(out, /wf_aaa/);
});

test("--any reports that silence too, so nothing holds the land gate shut without saying so", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  silence(space, "wf_aaa", 720);
  const { status, out } = askAny(space);
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
  assert.match(out, /journal silent 7[0-9][0-9]m/);
});

test("a lane still writing to its journal is not reported as silent", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const { status, out } = askAny(space);
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /journal silent/);
});

test("--stale-minutes is the window the silence is measured against", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  silence(space, "wf_aaa", 30);
  assert.match(askAny(space).out, /journal silent 30m/);
  assert.doesNotMatch(askAny(space, ["--stale-minutes", "45"]).out, /journal silent/);
});

test("--stale-minutes with no value is refused, not looped on forever", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const ran = spawnSync("bash", [SCRIPT, "--any", "--stale-minutes"], {
    encoding: "utf8",
    cwd: space.root,
    timeout: 5000,
    env: { ...process.env, ...GIT_ENV, DEVLOOP_ROOT: space.root, DEVLOOP_WF: space.wf, DEVLOOP_TASKS: space.tasks },
  });
  assert.equal(ran.signal, null, "the script had to be killed");
  assert.equal(ran.status, 6, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stderr, /--stale-minutes needs a value/);
});

test("a fresh agent transcript beside a cold journal is not silence", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  writeFileSync(
    join(space.wf, "session-1", "subagents", "workflows", "wf_aaa", "agent-a1.jsonl"),
    `${JSON.stringify({ type: "assistant", agentId: "a1" })}\n`,
  );
  silence(space, "wf_aaa", 720);
  const { status, out } = askAny(space);
  assert.equal(status, 0, out);
  assert.match(out, /^RUNNING/);
  assert.doesNotMatch(out, /journal silent/);
});

const AS_ROOT = process.getuid?.() === 0;

function unmeasurable(space: Workspace, run: string): string {
  const dir = join(space.wf, "session-1", "subagents", "workflows", run);
  chmodSync(dir, 0o111);
  return dir;
}

test(
  "a RUNNING lane whose journal age cannot be measured says so instead of reading as freshly written",
  { skip: AS_ROOT ? "root reads a directory whatever its mode, so no age can be made unmeasurable" : false },
  () => {
    const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
    const dir = unmeasurable(space, "wf_aaa");
    try {
      const { status, out } = askAny(space);
      assert.equal(status, 0, out);
      assert.match(out, /^RUNNING/);
      assert.match(out, /journal age unknown/);
      assert.doesNotMatch(out, /journal silent/);
      assert.doesNotMatch(out, /kill-lane\.sh/);
    } finally {
      chmodSync(dir, 0o755);
    }
  },
);

test(
  "an unmeasurable age is reported for one issue too, and the measured lane beside it is unchanged",
  { skip: AS_ROOT ? "root reads a directory whatever its mode, so no age can be made unmeasurable" : false },
  () => {
    const space = workspace([
      { task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] },
      { task: "w222", run: "wf_bbb", labels: ["fix:pitwall-90b"] },
    ]);
    silence(space, "wf_aaa", 720);
    const dir = unmeasurable(space, "wf_bbb");
    try {
      const { status, out } = ask(space, "pitwall-90b");
      assert.equal(status, 0, out);
      assert.match(out, /task w111, workflow wf_aaa, result not written, journal silent 7[0-9][0-9]m\.$/m);
      assert.match(out, /task w222, workflow wf_bbb, result not written, journal age unknown\.$/m);
    } finally {
      chmodSync(dir, 0o755);
    }
  },
);

test("a result written in one task directory cancels an empty copy of it in another", () => {
  const space = workspace([{ task: "w111", run: "wf_aaa", labels: ["fix:pitwall-90b"] }]);
  const second = join(space.root, "tasks-2");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "w111.output"), "pitwall-90b landed\n");
  const { status, out } = ask(space, "pitwall-90b", [], `${space.tasks} ${second}`);
  assert.equal(status, 1, out);
  assert.match(out, /^NOT-RUNNING/);
});
