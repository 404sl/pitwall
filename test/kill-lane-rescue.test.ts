import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "kill-lane.sh",
);

const ID = "app-kill1";

function git(dir: string, ...args: string[]): void {
  const ran = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(ran.status, 0, `git ${args.join(" ")} failed: ${ran.stderr}`);
}

interface Lane {
  root: string;
  repo: string;
  worktree: string;
  rescue: string;
  wf: string;
  tasks: string;
  prefix: string;
}

function lane(t: TestContext): Lane {
  const prefix = `pitwallkill-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const root = mkdtempSync(join(tmpdir(), "pitwall-kill-rescue-"));
  const repo = join(root, "site");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.email", "lane@example.com");
  git(repo, "config", "user.name", "lane");
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "first");

  const worktrees = `/tmp/${prefix}-worktrees`;
  const worktree = join(worktrees, ID);
  git(repo, "worktree", "add", "-q", "-b", `devloop/${ID}`, worktree);

  const wf = join(root, "projects");
  const tasks = join(root, "tasks");
  mkdirSync(wf, { recursive: true });
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, "w111.output"), "done\n");
  const run = "wf_aaa";
  const journal = join(wf, "session-1", "subagents", "workflows", run);
  mkdirSync(journal, { recursive: true });
  writeFileSync(
    join(journal, "journal.jsonl"),
    `${[
      JSON.stringify({ type: "launched" }),
      JSON.stringify({ type: "started", agentId: "a1", label: `fix:${ID}-other`, phase: "Fix" }),
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

  t.after(() => {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { encoding: "utf8" });
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  return { root, repo, worktree, rescue: join(root, "rescued"), wf, tasks, prefix };
}

function kill(l: Lane, opts: { rescue?: string; args?: readonly string[] } = {}) {
  const ran = spawnSync("bash", [SCRIPT, "--slot", "1", "--id", ID, ...(opts.args ?? [])], {
    cwd: l.root,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVLOOP_ROOT: l.root,
      DEVLOOP_WF: l.wf,
      DEVLOOP_TASKS: l.tasks,
      DEVLOOP_RESCUE: opts.rescue ?? l.rescue,
      LOCK_PREFIX: l.prefix,
    },
  });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

test("a rescue that captured fewer paths than the worktree held keeps the worktree", (t) => {
  const l = lane(t);
  writeFileSync(join(l.worktree, "notes.txt"), "half a fix\n");
  symlinkSync(l.repo, join(l.worktree, "node_modules"), "dir");

  const ran = kill(l);

  assert.match(
    ran.out,
    /RESCUE INCOMPLETE/,
    `a diff missing one of the two dirty paths must be reported as incomplete:\n${ran.out}${ran.err}`,
  );
  assert.doesNotMatch(ran.out, /\n {2}saved: /, `a truncated rescue must not be reported as saved:\n${ran.out}`);
  assert.equal(existsSync(l.worktree), true, "the only copy of the work must survive a rescue that fell short");
  assert.equal(ran.status, 8, `an incomplete rescue must not exit 0:\n${ran.out}${ran.err}`);
});

test("a rescue that cannot be written at all keeps the worktree", (t) => {
  const l = lane(t);
  writeFileSync(join(l.worktree, "notes.txt"), "half a fix\n");
  const blocker = join(l.root, "blocker");
  writeFileSync(blocker, "not a directory\n");

  const ran = kill(l, { rescue: join(blocker, "rescued") });

  assert.match(ran.out, /RESCUE INCOMPLETE/, `an unwritable rescue must be reported:\n${ran.out}${ran.err}`);
  assert.equal(existsSync(l.worktree), true, "a rescue that wrote nothing must not be followed by a removal");
  assert.equal(ran.status, 8, `an unwritable rescue must not exit 0:\n${ran.out}${ran.err}`);
});

test("--force overrides the running verdict, not the only copy of the work", (t) => {
  const l = lane(t);
  writeFileSync(join(l.worktree, "notes.txt"), "half a fix\n");
  symlinkSync(l.repo, join(l.worktree, "node_modules"), "dir");

  const ran = kill(l, { args: ["--force"] });

  assert.equal(ran.status, 8, `--force must not turn a truncated rescue into a removal:\n${ran.out}${ran.err}`);
  assert.equal(existsSync(l.worktree), true, "--force must not delete a worktree whose rescue fell short");
});

test("a complete rescue is saved and the lane is cleaned up", (t) => {
  const l = lane(t);
  writeFileSync(join(l.worktree, "tracked.txt"), "one\ntwo\n");
  writeFileSync(join(l.worktree, "notes.txt"), "half a fix\n");

  const ran = kill(l);

  assert.equal(ran.status, 0, `a complete rescue must clean the lane up:\n${ran.out}\n${ran.err}`);
  assert.match(ran.out, /\n {2}saved: /, `a complete rescue must report where it went:\n${ran.out}`);
  assert.equal(existsSync(l.worktree), false, "a rescued worktree must still be removed");

  const written = readdirSync(l.rescue);
  assert.equal(written.length, 1, `exactly one rescue diff was expected, got ${written.join(", ")}`);
  const diff = readFileSync(join(l.rescue, written[0]!), "utf8");
  assert.match(diff, /^diff --git a\/notes\.txt b\/notes\.txt$/m, `the new file the lane created is missing:\n${diff}`);
  assert.match(diff, /^diff --git a\/tracked\.txt b\/tracked\.txt$/m, `the edited file is missing:\n${diff}`);
});

test("the command the stopping message prints is the only thing that finishes the cleanup", (t) => {
  const l = lane(t);
  writeFileSync(join(l.worktree, "notes.txt"), "half a fix\n");
  symlinkSync(l.repo, join(l.worktree, "node_modules"), "dir");
  const lock = `/tmp/${l.prefix}-lane-2.lock`;
  mkdirSync(lock, { recursive: true });
  t.after(() => rmSync(lock, { recursive: true, force: true }));

  const first = kill(l);
  assert.equal(first.status, 8, `the truncated rescue must stop:\n${first.out}${first.err}`);

  const again = kill(l);
  assert.equal(again.status, 8, `a re-run with the worktree still there cannot finish:\n${again.out}${again.err}`);
  assert.equal(existsSync(lock), true, "the lane lock stays held while the worktree is still in place");

  const printed = first.out.split("\n").find((line) => line.includes("worktree remove --force"));
  assert.ok(printed, `the stopping message must print the command that unblocks the lane:\n${first.out}`);
  const removed = spawnSync("bash", ["-c", printed!], { encoding: "utf8" });
  assert.equal(removed.status, 0, `the printed command must run as printed: ${removed.stderr}`);
  assert.equal(existsSync(l.worktree), false, "the printed command must remove the worktree it names");
  assert.equal(existsSync(join(l.repo, "tracked.txt")), true, "the removal must not follow the symlink out of the worktree");

  const third = kill(l);
  assert.equal(third.status, 0, `with the worktree gone the re-run must finish:\n${third.out}${third.err}`);
  assert.match(third.out, /lane lock: .*\n {2}released/, `the lane lock must be released:\n${third.out}`);
  assert.equal(existsSync(lock), false, "the lane lock must be gone once the cleanup completes");
});
