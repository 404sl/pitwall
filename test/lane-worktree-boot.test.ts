import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { site: { path: "app", test: "bundle exec rspec", lint: "bundle exec rubocop", role: "rails" } },
};

const TRIAGE_OK = {
  eligible: true,
  repo: "site",
  title: "a fresh worktree cannot boot the app",
  priority: 2,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

function railsFixPrompt(calls: Call[]): string {
  const found = calls.filter((c) => c.label.startsWith("fix:"));
  assert.ok(found.length > 0, `no fix step was run. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found[0]!.prompt;
}

async function railsBrief(): Promise<string> {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (call.label.startsWith("fix:")) {
      return { status: "pushed", summary: "fixed", prNumber: 9, prUrl: "https://example.test/pr/9" };
    }
    if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
    if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 9, notes: "" };
    return { lane: "released", slot: "released" };
  });
  await done;
  return railsFixPrompt(calls);
}

test("a rails lane is given the commands that make its worktree boot", async () => {
  const prompt = await railsBrief();
  for (const command of [
    "ln -s /root/app/config/master.key /tmp/pw-worktrees/zz-aaa1/config/master.key",
    "ln -s /root/app/.env /tmp/pw-worktrees/zz-aaa1/.env",
    "ln -s /root/app/node_modules /tmp/pw-worktrees/zz-aaa1/node_modules",
  ]) {
    assert.ok(
      prompt.includes(command),
      "the rails brief no longer hands a lane " +
        command +
        ". All four pieces are gitignored, so a worktree cut from origin/master cannot boot the " +
        "app at all - without the key, credentials will not decrypt and every rails command dies " +
        "before loading a spec. Naming the files in prose is what failed: the commands have to be " +
        "runnable.",
    );
  }
  assert.ok(
    prompt.includes("bundle exec rails dartsass:build"),
    "the rails brief no longer tells a lane to build its own CSS. An unbuilt app/assets/builds " +
      "raises 'cannot load such file -- sassc', and CSS copied from the main checkout is older " +
      "than the branch and fails brand-token specs the branch never touched",
  );
});

test("the rails brief points at the repository it was dispatched into, not a hardcoded name", async () => {
  const prompt = await railsBrief();
  assert.ok(
    !prompt.includes("/root/site"),
    "the rails brief hardcodes /root/site as the main checkout. The repo key 'site' means 'the " +
      "primary deliverable' and its path comes from the config, so a project whose app lives " +
      "anywhere else is told to link from a directory that does not exist",
  );
});
