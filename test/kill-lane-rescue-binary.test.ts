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

const ID = "app-bin1";
const BASE = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a]);
const STAGED = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x20, 0x0a]);
const UNSTAGED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x0a]);

function git(dir: string, ...args: string[]): void {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, `git ${args.join(" ")} failed: ${ran.stderr}`);
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
  const prefix = `pitwallbin-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const root = mkdtempSync(join(tmpdir(), "pitwall-kill-binary-"));
  const repo = join(root, "site");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.email", "lane@example.com");
  git(repo, "config", "user.name", "lane");
  writeFileSync(join(repo, "staged.bin"), BASE);
  writeFileSync(join(repo, "unstaged.bin"), BASE);
  git(repo, "add", "staged.bin", "unstaged.bin");
  git(repo, "commit", "-qm", "first");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "fetch", "-q", "origin");

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
    spawnGit(["-C", repo, "worktree", "remove", "--force", worktree]);
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  return { root, repo, worktree, worktrees, rescue: join(root, "rescued"), wf, tasks, prefix };
}

function kill(l: Lane) {
  const ran = spawnSync("bash", [SCRIPT, "--slot", "1", "--id", ID], {
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

test("a dead lane's changes to tracked binary files are rescued as a patch git apply can replay", (t) => {
  const l = lane(t);
  writeFileSync(join(l.worktree, "staged.bin"), STAGED);
  git(l.worktree, "add", "staged.bin");
  writeFileSync(join(l.worktree, "unstaged.bin"), UNSTAGED);

  const ran = kill(l);

  assert.equal(ran.status, 0, `the rescue must clean the lane up:\n${ran.out}\n${ran.err}`);
  assert.match(ran.out, /\n {2}saved: /, `the rescue must report where it went:\n${ran.out}`);
  assert.equal(existsSync(l.worktree), false, "a rescued worktree must still be removed");

  const written = readdirSync(l.rescue);
  assert.equal(written.length, 1, `exactly one rescue diff was expected, got ${written.join(", ")}`);
  const out = join(l.rescue, written[0]!);
  const diff = readFileSync(out, "utf8");
  assert.equal(
    (diff.match(/^GIT binary patch$/gm) ?? []).length,
    2,
    `both tracked binary files must be rescued as GIT binary patches, not as "Binary files differ":\n${diff}`,
  );
  assert.doesNotMatch(diff, /^Binary files .* differ$/m, `a one-line "Binary files differ" cannot be replayed:\n${diff}`);

  const fresh = join(l.worktrees, "fresh");
  git(l.repo, "worktree", "add", "-q", "--detach", fresh, "master");
  const applied = spawnGit(["apply", out], { cwd: fresh });
  assert.equal(applied.status, 0, `git apply of the rescue diff must succeed against the base commit: ${applied.stderr}\n${diff}`);
  assert.deepEqual(readFileSync(join(fresh, "staged.bin")), STAGED, "the staged binary change must be restored byte for byte");
  assert.deepEqual(readFileSync(join(fresh, "unstaged.bin")), UNSTAGED, "the unstaged binary change must be restored byte for byte");
});
