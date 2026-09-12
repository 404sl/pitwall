import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const NODE_REPOS = {
  site: { path: "main", slug: "404sl/pitwall", role: "node", test: "npm test", lint: "npm run lint" },
};

function fixPrompt(calls: Call[]): string {
  const found = calls.find((c) => c.label.startsWith("fix:"));
  assert.ok(found, `no fix step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found.prompt;
}

async function nodeBrief(args: Record<string, unknown> = {}): Promise<string> {
  const { calls, done } = runScript(
    "task.js",
    { id: "zz-aaa1", slot: 3, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: NODE_REPOS, ...args },
    (call, n) => {
      if (n === 1) {
        return { eligible: true, repo: "site", title: "a lane cannot share its dependencies", priority: 2, ui: false, reason: "", ticket: "the ticket body" };
      }
      if (call.label.startsWith("fix:")) {
        return { status: "pushed", summary: "fixed", prNumber: 61, prUrl: "https://example.test/pr/61" };
      }
      if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
      if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 61, notes: "" };
      return { lane: "released", slot: "released" };
    },
  );
  await done;
  return fixPrompt(calls);
}

function linkCommand(prompt: string): string {
  const found = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("ln -s") && line.includes("node_modules"));
  assert.equal(
    found.length,
    1,
    `the node brief carries ${found.length} commands that link node_modules rather than one, so this ` +
      `test can no longer say which of them a lane runs:\n${found.join("\n")}`,
  );
  return found[0]!;
}

test("the node brief guards the node_modules link against a worktree that already has one", async () => {
  const command = linkCommand(await nodeBrief());
  assert.equal(
    command,
    "test -L /tmp/pw-worktrees/zz-aaa1/node_modules || ln -s /root/main/node_modules /tmp/pw-worktrees/zz-aaa1/node_modules",
    "the node brief hands a lane a bare 'ln -s' for its dependencies. The per-repo checks block is " +
      "emitted on every attempt, not only the first, so a rework run is given this command against a " +
      "worktree that already holds the link - and 'ln -s SRC DEST' where DEST is an existing symlink " +
      "to a directory follows DEST and creates SRC's basename inside the target, which is the main " +
      "checkout. The result is node_modules/node_modules in somebody else's working copy, at exit 0 " +
      "with no output and invisible to 'git status' because node_modules is gitignored. The guard is " +
      "spelled 'test -L' because the overwrite flag is -n on GNU and -h on BSD and neither is portable",
  );
});

test("running the node brief's link command twice writes nothing into the main checkout", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "pw-node-boot-"));
  try {
    const main = join(sandbox, "main", "node_modules");
    const worktree = join(sandbox, "wt", "zz-aaa1");
    mkdirSync(main, { recursive: true });
    mkdirSync(worktree, { recursive: true });

    const command = linkCommand(await nodeBrief({ root: sandbox, worktrees: join(sandbox, "wt") }));
    execFileSync("sh", ["-c", command]);
    execFileSync("sh", ["-c", command]);

    assert.ok(
      lstatSync(join(worktree, "node_modules")).isSymbolicLink(),
      "the node brief's link command left the worktree with no node_modules symlink, so a lane that " +
        "runs it still has to reinstall its dependencies. A guard that skips the first creation is not " +
        "a fix, it is the same worktree failing one step later",
    );
    assert.deepEqual(
      readdirSync(main),
      [],
      "running the node brief's link command a second time wrote into the main checkout's node_modules. " +
        "That is the trap the guard exists for: the second 'ln -s' followed the symlink the first one " +
        "made and created a self-referential loop inside the owner's own dependency directory, which " +
        "no lane is allowed to write to and nothing downstream reports",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
