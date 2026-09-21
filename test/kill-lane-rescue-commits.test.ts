import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "kill-lane.sh",
);

const ID = "app-cmt1";
const BRANCH = `devloop/${ID}`;

function git(dir: string, ...args: string[]): string {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, `git ${args.join(" ")} failed: ${ran.stderr}`);
  return ran.stdout;
}

interface Lane {
  root: string;
  repo: string;
  worktree: string;
  worktrees: string;
  rescue: string;
  wf: string;
  tasks: string;
  prefix: string;
}

function lane(t: TestContext): Lane {
  const prefix = `pitwallcmt-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const root = mkdtempSync(join(tmpdir(), "pitwall-kill-commits-"));
  const repo = join(root, "site");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.email", "lane@example.com");
  git(repo, "config", "user.name", "lane");
  writeFileSync(join(repo, "lib.txt"), "base\n");
  git(repo, "add", "lib.txt");
  git(repo, "commit", "-qm", "first");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "fetch", "-q", "origin");

  const worktrees = `/tmp/${prefix}-worktrees`;
  const worktree = join(worktrees, ID);
  git(repo, "worktree", "add", "-q", "-b", BRANCH, worktree, "origin/master");

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
    spawnGit(["-C", repo, "worktree", "remove", "--force", worktree]);
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  return { root, repo, worktree, worktrees, rescue: join(root, "rescued"), wf, tasks, prefix };
}

function commitOnLane(l: Lane): void {
  writeFileSync(join(l.worktree, "lib.txt"), "base\nfinished on brief\n");
  writeFileSync(join(l.worktree, "new.txt"), "a file the lane created\n");
  git(l.worktree, "add", "lib.txt", "new.txt");
  git(l.worktree, "commit", "-qm", "Finish the change the ticket asked for");
}

function kill(l: Lane, ...args: string[]) {
  const ran = spawnSync("bash", [SCRIPT, "--slot", "1", "--id", ID, ...args], {
    cwd: l.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: l.root,
      DEVLOOP_WF: l.wf,
      DEVLOOP_TASKS: l.tasks,
      DEVLOOP_RESCUE: l.rescue,
      LOCK_PREFIX: l.prefix,
    },
  });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function branchExists(l: Lane): boolean {
  return spawnGit(["-C", l.repo, "show-ref", "--verify", "--quiet", `refs/heads/${BRANCH}`]).status === 0;
}

test("a dead lane's commits that never reached a remote are rescued as patches before the branch is deleted", (t) => {
  const l = lane(t);
  commitOnLane(l);
  assert.equal(git(l.worktree, "status", "--porcelain"), "", "the fixture must start with a clean tree");

  const ran = kill(l);

  assert.equal(ran.status, 0, `the rescue must clean the lane up:\n${ran.out}\n${ran.err}`);
  assert.match(ran.out, /UNPUSHED COMMITS PRESENT - 1 commit/, `the cleanup must say the branch held work:\n${ran.out}`);
  assert.match(ran.out, /Finish the change the ticket asked for/, `the cleanup must list the commits it found:\n${ran.out}`);
  assert.match(ran.out, /\n {2}saved: /, `the rescue must report where it went:\n${ran.out}`);
  assert.equal(existsSync(l.worktree), false, "the worktree must still be removed");
  assert.equal(branchExists(l), false, "a rescued never-pushed branch must still be deleted so a re-dispatch can create it");

  const written = readdirSync(l.rescue);
  assert.equal(written.length, 1, `exactly one rescue file was expected, got ${written.join(", ")}`);
  const out = join(l.rescue, written[0]!);
  assert.match(written[0]!, /\.mbox$/, "commits are rescued as a mailbox git am replays, not as a bare diff");
  const mbox = readFileSync(out, "utf8");
  assert.match(mbox, /^From: lane <lane@example\.com>$/m, `the rescued commit must keep its author:\n${mbox}`);
  assert.match(mbox, /^Subject: \[PATCH\] Finish the change the ticket asked for$/m, `the rescued commit must keep its message:\n${mbox}`);

  const fresh = join(l.worktrees, "fresh");
  git(l.repo, "worktree", "add", "-q", "--detach", fresh, "master");
  const applied = spawnGit(["am", out], { cwd: fresh });
  assert.equal(applied.status, 0, `git am of the rescue must succeed against the base commit: ${applied.stderr}\n${mbox}`);
  assert.equal(readFileSync(join(fresh, "lib.txt"), "utf8"), "base\nfinished on brief\n");
  assert.equal(readFileSync(join(fresh, "new.txt"), "utf8"), "a file the lane created\n");
  assert.match(git(fresh, "log", "-1", "--format=%s"), /^Finish the change the ticket asked for/);
});

test("a dry run names the rescue it would write and deletes nothing", (t) => {
  const l = lane(t);
  commitOnLane(l);

  const ran = kill(l, "--dry-run");

  assert.equal(ran.status, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /UNPUSHED COMMITS PRESENT - 1 commit/, ran.out);
  assert.match(ran.out, /would save to: /, ran.out);
  assert.equal(existsSync(l.rescue), false, "a dry run must write no rescue file");
  assert.equal(branchExists(l), true, "a dry run must leave the branch in place");
  assert.equal(existsSync(l.worktree), true, "a dry run must leave the worktree in place");
});

test("a never-pushed branch with nothing beyond the remote is deleted without a rescue", (t) => {
  const l = lane(t);

  const ran = kill(l);

  assert.equal(ran.status, 0, `${ran.out}\n${ran.err}`);
  assert.doesNotMatch(ran.out, /UNPUSHED COMMITS PRESENT/, ran.out);
  assert.doesNotMatch(ran.out, /saved: /, ran.out);
  assert.equal(existsSync(l.rescue), false, "nothing to rescue must write nothing");
  assert.equal(branchExists(l), false);
});
