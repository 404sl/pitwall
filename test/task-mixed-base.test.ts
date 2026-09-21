import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

function repos(site: string | undefined, integration: string | undefined) {
  return {
    site: { path: "cli", slug: "acme/thing", test: "npm test", role: "node", defaultBranch: site },
    integration: { path: "schema", slug: "acme/thing-schema", test: "npm test", role: "node", defaultBranch: integration },
  };
}

const SPLIT_PLAN = [
  { title: "the contract field", repo: "integration", scope: "adds a field", autonomous: true },
  { title: "the consumer", repo: "site", scope: "reads it", autonomous: true },
];

const TRIAGE = {
  eligible: false,
  splittable: true,
  reason: "two repositories",
  repo: "site",
  title: "a field and the code that reads it",
  priority: 1,
  ui: false,
  ticket: "the ticket body",
  splitPlan: SPLIT_PLAN,
};

async function splitPrompt(site: string | undefined, integration: string | undefined): Promise<string> {
  const args = { id: "zz-aaa1", slot: 3, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: repos(site, integration) };
  const { calls, done } = runScript("task.js", args, (call: Call, n: number) => {
    if (n === 1) return TRIAGE;
    if (call.label.startsWith("split:")) return "created zz-aaa1.1 and zz-aaa1.2";
    return { lane: "released", slot: "released" };
  });
  const result = await done;
  assert.equal(result["outcome"], "split", `the run did not reach the split step: ${calls.map((c) => c.label).join(", ")}`);
  const split = calls.find((c) => c.label === "split:zz-aaa1");
  assert.ok(split, `no split step ran. Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  return split.prompt;
}

const ONE_BASE = 'git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" commit -F <message file>';

test("the split prompt names each repository's base when the repositories do not share a default branch", async () => {
  const prompt = await splitPrompt("master", "main");
  const refs = [...prompt.matchAll(/origin\/([^\s:.)'`]+)/g)].map((m) => m[1] ?? "");
  const unresolved = refs.filter((ref) => !/^(master|main)$/.test(ref));
  assert.deepEqual(unresolved, [], `the split prompt names a remote branch nobody has: ${unresolved.join(", ")}\n${prompt}`);
  assert.equal(prompt.includes("<default branch>"), false, "the split prompt hands the session a placeholder to guess at");
  assert.ok(prompt.includes("site (/root/cli)  origin/master"), "the split prompt does not say which base site commits are built on");
  assert.ok(prompt.includes("integration (/root/schema)  origin/main"), "the split prompt does not say which base integration commits are built on");
  assert.ok(prompt.includes("--format=%an <base>)"), "the identity command does not take the listed base");
  assert.ok(prompt.includes("where <base> is the remote-tracking ref listed beside the repository"), "the identity command's <base> is never defined");
  assert.equal(prompt.includes("`"), false, "a backtick in the split prompt closes its template literal early");
});

test("the split prompt is unchanged when every repository shares one default, or none is configured", async () => {
  const shared = await splitPrompt("master", "master");
  const unset = await splitPrompt(undefined, undefined);
  assert.equal(shared, unset, "the split prompt reads differently with a shared default configured than with none");
  assert.ok(shared.includes(ONE_BASE), `the split prompt no longer carries the one-line identity command:\n${shared}`);
  assert.equal(shared.includes("<base>"), false, "the split prompt uses a placeholder when every repository shares one base");
  assert.equal(shared.includes("<branch>"), false, "the split prompt uses a placeholder when every repository shares one base");
  assert.equal(shared.includes("site (/root/cli)  origin/"), false, "the split prompt lists bases per repository when they all share one");
  assert.equal(shared.includes("<default branch>"), false);
  assert.equal(shared.includes("do not share a default branch"), false);
});
