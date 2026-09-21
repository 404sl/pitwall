import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const REPOS = {
  site: { path: "cli", slug: "404sl/pitwall", role: "node", test: "npm test", lint: "npm run lint" },
};

const ARGS = { id: "zz-aaa1", slot: 3, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: REPOS };

async function briefs(): Promise<Call[]> {
  const { calls, done } = runScript("task.js", ARGS, (call, n) => {
    if (n === 1) {
      return { eligible: true, repo: "site", title: "a brief that sees its own errors", priority: 3, ui: false, reason: "", ticket: "the ticket body" };
    }
    if (call.label.startsWith("fix:")) {
      return { status: "pushed", summary: "fixed", prNumber: 47, prUrl: "https://example.test/pr/47" };
    }
    if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
    if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 47, notes: "" };
    return { lane: "released", slot: "released" };
  });
  await done;
  return calls;
}

function step(calls: Call[], prefix: string): Call {
  const found = calls.find((c) => c.label.startsWith(prefix));
  assert.ok(found, `no ${prefix} step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found;
}

function commandsOnly(prompt: string): string {
  return prompt.replace(/(^|[\s(:])'[^'\n]*'/g, "$1''").replace(/never use\s+2>&1/gi, "");
}

test("no brief hands a run a command that merges stderr into stdout", async () => {
  const calls = await briefs();
  for (const call of calls) {
    const left = commandsOnly(call.prompt)
      .split("\n")
      .filter((line) => line.includes("2>&1"));
    assert.deepEqual(
      left,
      [],
      `the ${call.label} brief names 2>&1 outside the sentence that forbids it. The rule is stated in ` +
        `every brief and still got broken three times in one night, so a command carrying it is handed ` +
        `out as the thing to type:\n${left.join("\n")}`,
    );
  }
});

test("the fix brief shows how to read a failure without merging stderr", async () => {
  const fix = step(await briefs(), "fix:");
  assert.ok(
    fix.prompt.includes("<command> 2>/tmp/pw-scratch/zz-aaa1/stderr.txt | tail -20"),
    "the fix brief forbids 2>&1 at its setup probes and hands no substitute, so a run that wants the " +
      "error message composes the habitual idiom freehand",
  );
  assert.ok(
    fix.prompt.includes("cat /tmp/pw-scratch/zz-aaa1/stderr.txt"),
    "the fix brief files stderr but never says to read the file back",
  );
});

test("the handoff brief hands over the worktree removal ready-made, with its failure idiom beside it", async () => {
  const handoff = step(await briefs(), "handoff:");
  const remove = "git -C /root/cli worktree remove /tmp/pw-worktrees/zz-aaa1 --force";
  assert.ok(
    handoff.prompt.includes(`\n     ${remove}\n`),
    "the handoff brief does not hand over the exact worktree-removal command, so a run composes its own - " +
      "and a cleanup step piped into tail is where the merge keeps getting written",
  );
  assert.ok(
    handoff.prompt.includes(`${remove} 2>/tmp/pw-scratch/zz-aaa1/worktree-remove.txt`),
    "the handoff brief gives no way to keep the removal's error without merging stderr",
  );
  assert.ok(
    handoff.prompt.includes("cat /tmp/pw-scratch/zz-aaa1/worktree-remove.txt"),
    "the handoff brief files the removal's stderr but never says to read it back",
  );
  const removal = handoff.prompt.indexOf("4. REMOVE YOUR WORKTREE");
  const rules = handoff.prompt.indexOf("7. Never use 2>&1");
  assert.notEqual(removal, -1, "the worktree removal step moved - update this test rather than deleting it");
  assert.notEqual(rules, -1, "rule 7 moved - update this test rather than deleting it");
  assert.ok(
    /never use 2>&1/i.test(handoff.prompt.slice(removal, rules)),
    "the prohibition is only in the rules list, not beside the step that tempts it",
  );
});
