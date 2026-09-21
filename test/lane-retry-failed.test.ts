import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  dispatch: "0123456789abcdef",
  repos: { site: { path: "repo", test: "npm test", role: "node" } },
};

const TRIAGE_OK = { eligible: true, repo: "site", title: "a fix", priority: 2, ui: false, reason: "", ticket: "the ticket body" };
const PUSHED = { status: "pushed", summary: "fixed", prNumber: 61, prUrl: "https://example.test/pr/61" };
const GIVEN_BACK = { lane: "released", slot: "released", worktree: "clean" };

function labelled(calls: Call[], label: string): Call[] {
  return calls.filter((c) => c.label === label);
}

function run(args: Record<string, unknown>, fix: (n: number) => unknown, handoff: (n: number) => unknown = () => ({ status: "verified", verified: true, prNumber: 61, notes: "" })) {
  let fixes = 0;
  let handoffs = 0;
  return runScript("task.js", args, (call) => {
    if (call.label === "triage:zz-aaa1") return TRIAGE_OK;
    if (call.label === "fix:zz-aaa1") return fix(++fixes);
    if (call.label === "review:zz-aaa1") return { approved: true, notes: "good" };
    if (call.label === "handoff:zz-aaa1") return handoff(++handoffs);
    if (call.label.startsWith("release")) return GIVEN_BACK;
    throw new Error(`unexpected step ${call.label}`);
  });
}

test("without retryFailed a fix step that answers blocked ends the run, exactly as before", async () => {
  const { calls, done } = run(ARGS, (n) => (n === 1 ? { status: "blocked", summary: "stopped: permission denied writing the worktree" } : PUSHED));
  const result = await done;
  assert.equal(labelled(calls, "fix:zz-aaa1").length, 1, `the fix step ran more than once. Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  assert.equal(labelled(calls, "review:zz-aaa1").length, 0);
  assert.equal(result["outcome"], "blocked");
  assert.equal(result["summary"], "stopped: permission denied writing the worktree");
});

test("with retryFailed a fix step that answers blocked is issued once more with a different prompt, and a success continues the run", async () => {
  const { calls, done } = run({ ...ARGS, retryFailed: true }, (n) => (n === 1 ? { status: "blocked", summary: "stopped: permission denied writing the worktree" } : PUSHED));
  const result = await done;
  const fixes = labelled(calls, "fix:zz-aaa1");
  assert.equal(fixes.length, 2, `the fix step was not re-issued exactly once. Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  const [first, second] = fixes as [Call, Call];
  assert.notEqual(second.prompt, first.prompt, "the re-issued prompt is identical to the first, so the runner would replay the same cached answer");
  assert.ok(second.prompt.startsWith(first.prompt), "the re-issued prompt does not carry the whole original brief");
  assert.match(second.prompt, /THIS STEP IS BEING RE-RUN/);
  assert.match(second.prompt, /blocked: stopped: permission denied writing the worktree/);
  assert.equal(second.prompt.includes("`"), false, "a backtick in the prompt closes its template literal early");
  assert.deepEqual(second.schema, first.schema);
  assert.equal(labelled(calls, "review:zz-aaa1").length, 1, "a successful retry did not reach review");
  assert.equal(labelled(calls, "handoff:zz-aaa1").length, 1);
  assert.equal(result["outcome"], "verified");
  assert.equal(result["attempts"], 1, "the retry consumed a review round");
});

test("with retryFailed a fix step that answers needs_feedback is re-issued the same way", async () => {
  const { calls, done } = run({ ...ARGS, retryFailed: true }, (n) => (n === 1 ? { status: "needs_feedback", question: "which of the two headings?" } : PUSHED));
  const result = await done;
  const fixes = labelled(calls, "fix:zz-aaa1");
  assert.equal(fixes.length, 2);
  assert.match(fixes[1]!.prompt, /needs_feedback: which of the two headings\?/);
  assert.equal(result["outcome"], "verified");
});

test("with retryFailed a step is re-issued once, not until it succeeds", async () => {
  const { calls, done } = run({ ...ARGS, retryFailed: true }, () => ({ status: "blocked", summary: "still stopped" }));
  const result = await done;
  assert.equal(labelled(calls, "fix:zz-aaa1").length, 2, `Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  assert.equal(labelled(calls, "review:zz-aaa1").length, 0);
  assert.equal(result["outcome"], "blocked");
  assert.equal(result["summary"], "still stopped");
});

test("with retryFailed a step that succeeds is not re-issued, and a genuine result is never retried", async () => {
  const { calls, done } = run({ ...ARGS, retryFailed: true }, () => ({ status: "no_change_needed", summary: "already fixed on master" }));
  const result = await done;
  assert.equal(labelled(calls, "fix:zz-aaa1").length, 1);
  assert.equal(result["outcome"], "no_change_needed");
});

test("with retryFailed a handoff that answers blocked is re-issued once too", async () => {
  const { calls, done } = run({ ...ARGS, retryFailed: true }, () => PUSHED, (n) => (n === 1 ? { status: "blocked", notes: "gh could not be reached" } : { status: "verified", verified: true, prNumber: 61, notes: "" }));
  const result = await done;
  const handoffs = labelled(calls, "handoff:zz-aaa1");
  assert.equal(handoffs.length, 2, `Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  assert.notEqual(handoffs[1]!.prompt, handoffs[0]!.prompt);
  assert.equal(result["outcome"], "verified");
});

test("the retry flag never reaches a prompt that must still replay from cache", async () => {
  const flagged = run({ ...ARGS, retryFailed: true }, () => PUSHED);
  const plain = run(ARGS, () => PUSHED);
  await Promise.all([flagged.done, plain.done]);
  for (const label of ["triage:zz-aaa1", "fix:zz-aaa1", "review:zz-aaa1", "handoff:zz-aaa1"]) {
    assert.equal(labelled(flagged.calls, label)[0]!.prompt, labelled(plain.calls, label)[0]!.prompt, `${label} prompt differs when the flag is set, so a resume with it would replay nothing`);
  }
});
