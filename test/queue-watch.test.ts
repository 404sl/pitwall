import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function lanesBusy(space: Workspace): string {
  const source = readFileSync(join(SKILL, "queue-watch.sh"), "utf8");
  const start = source.indexOf("lanes_busy() {");
  assert.notEqual(start, -1, "lanes_busy moved - update this test rather than deleting it");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "could not find the end of lanes_busy");
  const driver = [
    `skill=${JSON.stringify(SKILL)}`,
    source.slice(start, end + 2),
    "lanes_busy",
    "",
  ].join("\n");
  const ran = spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      DEVLOOP_ROOT: space.root,
      DEVLOOP_WF: space.wf,
      DEVLOOP_TASKS: space.tasks,
    },
  });
  return `${ran.stdout ?? ""}`.trim();
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
