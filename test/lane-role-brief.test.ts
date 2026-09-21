import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const REPOS = {
  handbook: { path: "hb", slug: "acme/handbook", role: "script", test: "make check" },
  docs: { path: "app", slug: "acme/app", role: "rails", test: "bundle exec rspec" },
  api: { path: "svc", slug: "acme/svc", role: "script" },
};

async function fixBrief(repo: string): Promise<string> {
  const { calls, done } = runScript(
    "task.js",
    { id: "zz-aaa1", slot: 3, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: REPOS },
    (call, n) => {
      if (n === 1) return { eligible: true, repo, title: "a fix", priority: 2, ui: false, reason: "", ticket: `Repo: ${repo}` };
      if (call.label.startsWith("fix:")) return { status: "pushed", summary: "fixed", prNumber: 61, prUrl: "https://example.test/pr/61" };
      if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
      if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 61, notes: "" };
      return { lane: "released", slot: "released" };
    },
  );
  await done;
  const found = calls.find((c: Call) => c.label.startsWith("fix:"));
  assert.ok(found, `no fix step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found.prompt;
}

function ruleFive(brief: string): string {
  const start = brief.indexOf("\n5. ");
  assert.notEqual(start, -1, "the brief has no rule 5");
  const rest = brief.slice(start + 1);
  const end = rest.indexOf("\n\nIF YOUR CHANGE TOUCHES plugins/");
  return end === -1 ? rest : rest.slice(0, end);
}

test("a script-role repo under a key other than docs is told to branch from its own checkout", async () => {
  const brief = await fixBrief("handbook");
  assert.match(brief, /NEVER BRANCH INSIDE \/root\/hb ITSELF/);
  assert.match(brief, /cd \/root\/hb && git fetch origin --quiet/);
  assert.doesNotMatch(brief, /\/root\/docs/, "the script-role brief still points at a checkout called docs");
});

test("a script-role repo gets the check-script rule 5, naming its own configured command", async () => {
  const five = ruleFive(await fixBrief("handbook"));
  assert.match(five, /^5\. Run 'make check', then commit/);
  assert.doesNotMatch(five, /check\.rb/, "rule 5 still names the docs repository's check script");
  assert.doesNotMatch(five, /Commit with the identity on the command/);
});

test("a script-role repo with no configured command is told to run the check script rather than a named one", async () => {
  const five = ruleFive(await fixBrief("api"));
  assert.match(five, /^5\. Run the check script, then commit/);
  assert.doesNotMatch(five, /check\.rb/);
});

test("a rails-role repo keyed docs gets the rails rule 5 and the rails checks, not the check-script ones", async () => {
  const brief = await fixBrief("docs");
  assert.match(brief, /TEST_ENV_NUMBER=4/, "the rails checks block was not emitted");
  assert.doesNotMatch(brief, /NEVER BRANCH INSIDE/, "the script-role checks block was emitted for a rails repo");
  const five = ruleFive(brief);
  assert.match(five, /^5\. Commit with the identity on the command/);
  assert.doesNotMatch(five, /check\.rb/, "a rails repository keyed docs is still handed the check-script step");
});
