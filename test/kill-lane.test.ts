import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

type Verdict = "running" | "unknown" | "not-running";

interface Fixture {
  root: string;
  wf: string;
  tasks: string;
  prefix: string;
}

function fixture(verdict: Verdict, id: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pitwall-kill-lane-"));
  const wf = join(root, "projects");
  const tasks = join(root, "tasks");
  mkdirSync(join(root, "site", ".git"), { recursive: true });
  mkdirSync(wf, { recursive: true });
  mkdirSync(tasks, { recursive: true });

  const run = "wf_aaa";
  const labels = verdict === "running" ? [`fix:${id}`] : [`fix:${id}-other`];
  writeFileSync(join(tasks, "w111.output"), verdict === "not-running" ? "done\n" : "");
  if (verdict !== "unknown") {
    const dir = join(wf, "session-1", "subagents", "workflows", run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "journal.jsonl"),
      `${[
        JSON.stringify({ type: "launched" }),
        ...labels.map((label) => JSON.stringify({ type: "started", agentId: "a1", label, phase: "Fix" })),
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
          scriptPath: "/w/.autofix-run/task.js",
        },
      })}\n`,
    );
  } else {
    writeFileSync(join(wf, "session-1.jsonl"), "");
  }
  return { root, wf, tasks, prefix: `pitwall-kill-lane-${process.pid}-${Math.random().toString(36).slice(2)}` };
}

function kill(space: Fixture, id: string, args: readonly string[] = []) {
  return run(space, ["--slot", "2", "--id", id, ...args]);
}

function run(space: Fixture, args: readonly string[]) {
  const ran = spawnSync("bash", [join(SKILL, "kill-lane.sh"), ...args], {
    encoding: "utf8",
    cwd: space.root,
    timeout: 5000,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: space.root,
      DEVLOOP_WF: space.wf,
      DEVLOOP_TASKS: space.tasks,
      DEVLOOP_RESCUE: join(space.root, "rescued"),
      LOCK_PREFIX: space.prefix,
    },
  });
  return { status: ran.status ?? -1, signal: ran.signal, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function worktreeMidRebase(space: Fixture, id: string): string {
  const wt = join("/tmp", `${space.prefix}-worktrees`, id);
  mkdirSync(join(wt, ".git", "objects"), { recursive: true });
  mkdirSync(join(wt, ".git", "refs"), { recursive: true });
  mkdirSync(join(wt, ".git", "rebase-merge"), { recursive: true });
  writeFileSync(join(wt, ".git", "HEAD"), "ref: refs/heads/devloop/pitwall-90b\n");
  return wt;
}

test("kill-lane refuses to clean up an issue whose lane is still running", () => {
  const space = fixture("running", "pitwall-90b");
  const { status, out, err } = kill(space, "pitwall-90b");
  assert.equal(status, 7, `${out}${err}`);
  assert.match(err, /REFUSING to clean up pitwall-90b/);
  assert.match(err, /still running/);
  assert.doesNotMatch(out, /Cleaning up lane/);
});

test("kill-lane refuses when it cannot establish whether a lane is running", () => {
  const space = fixture("unknown", "pitwall-90b");
  const { status, out, err } = kill(space, "pitwall-90b");
  assert.equal(status, 7, `${out}${err}`);
  assert.match(err, /cannot establish/);
  assert.match(err, /UNKNOWN is not dead/);
  assert.doesNotMatch(out, /Cleaning up lane/);
});

test("kill-lane proceeds when nothing in flight belongs to the issue", () => {
  const space = fixture("not-running", "pitwall-90b");
  const { status, out, err } = kill(space, "pitwall-90b");
  assert.equal(status, 0, `${out}${err}`);
  assert.doesNotMatch(err, /REFUSING/);
  assert.match(out, /Cleaning up lane/);
});

test("--force skips the check rather than paying for a verdict it discards", () => {
  const space = fixture("running", "pitwall-90b");
  const { status, out, err } = kill(space, "pitwall-90b", ["--force"]);
  assert.equal(status, 0, `${out}${err}`);
  assert.doesNotMatch(err, /REFUSING/);
  assert.match(out, /Cleaning up lane/);
  assert.doesNotMatch(out, /still in flight/);
});

test("kill-lane refuses while a rebase is in progress in the worktree, and removes nothing", () => {
  const space = fixture("not-running", "pitwall-90b");
  const wt = worktreeMidRebase(space, "pitwall-90b");
  try {
    const { status, out, err } = kill(space, "pitwall-90b");
    assert.equal(status, 7, `${out}${err}`);
    assert.match(err, /REFUSING to clean up pitwall-90b/);
    assert.match(err, /mid-rebase-merge/);
    assert.equal(existsSync(wt), true, "the worktree was removed despite the refusal");
    assert.doesNotMatch(out, /Cleaning up lane/);
  } finally {
    rmSync(join("/tmp", `${space.prefix}-worktrees`), { recursive: true, force: true });
  }
});

test("--force clears a worktree mid-rebase once a person has confirmed it", () => {
  const space = fixture("not-running", "pitwall-90b");
  const wt = worktreeMidRebase(space, "pitwall-90b");
  try {
    const { status, out, err } = kill(space, "pitwall-90b", ["--force"]);
    assert.equal(status, 0, `${out}${err}`);
    assert.doesNotMatch(err, /REFUSING/);
    assert.equal(existsSync(wt), false);
  } finally {
    rmSync(join("/tmp", `${space.prefix}-worktrees`), { recursive: true, force: true });
  }
});

test("a flag that takes a value is refused when given none, not looped on forever", () => {
  const space = fixture("not-running", "pitwall-90b");
  for (const args of [["--slot"], ["--slot", "2", "--id"], ["--slot", "2", "--id", "pitwall-90b", "--repo"]]) {
    const { status, signal, out, err } = run(space, args);
    assert.equal(signal, null, `${args.join(" ")}: the script had to be killed`);
    assert.equal(status, 6, `${args.join(" ")}: ${out}${err}`);
    assert.match(err, new RegExp(`${args[args.length - 1]} needs a value`));
    assert.match(err, /usage: kill-lane.sh/);
  }
});
