import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";
const TOKEN = "lander-1788964650-29574";

const NO_PLUGIN = {
  fetched: true,
  status: "no_manifest",
  masterVersion: "",
  branchVersion: "",
  touchesPlugin: false,
  labelled: true,
  open: true,
  notes: "this repository carries no devloop plugin manifest on master",
};

function repos(site: string | undefined, docs: string | undefined) {
  return {
    site: { path: "cli", slug: "acme/app", defaultBranch: site },
    docs: {
      path: "site",
      slug: "acme/site",
      defaultBranch: docs,
      deploy: ["bash deploy-one.sh --label staging"],
      verify: "curl -s -m 20 https://staging.example.com/health",
    },
  };
}

const MERGED = { slug: "acme/site", number: 16, title: "Rewrite the headline", branch: "devloop/pitwall-7b1", issue: "pitwall-7b1" };
const DEAD = { slug: "acme/app", number: 9, title: "Rename the console", branch: "devloop/pitwall-7b2", issue: "pitwall-7b2" };
const ASKED = ["acme/app", "acme/site"].flatMap((slug) => [MERGED, DEAD].map((pr) => ({ slug, branch: pr.branch })));

function lander(site: string | undefined, docs: string | undefined) {
  return runScript("land.js", { skillDir: "/skill", root: "/root", lockToken: TOKEN, repos: repos(site, docs) }, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: TOKEN, holder: TOKEN };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: [MERGED, DEAD] } : { prs: [] };
    if (call.label.startsWith("version:")) return NO_PLUGIN;
    if (call.label === "land:acme/site#16") return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    if (call.label.startsWith("land:")) return { status: "conflict", notes: "superseded on master" };
    if (call.label === "deploy") return { status: "deployed", hosts: [], notes: "" };
    if (call.label === "deploy-check") return { status: "read", hosts: [{ repo: "docs", environment: "only", revision: SHA }], notes: "" };
    if (call.label === "branch-survey") return { status: "read", asked: ASKED, prs: [] };
    if (call.label === "close") return { closed: ["pitwall-7b1"], notes: "" };
    if (call.label.startsWith("retire:")) return { status: "retired", retired: ["pitwall-7b2"] };
    return { status: "released" };
  });
}

const EVERY_STEP = ["lock", "survey", "survey#2", "retire:1", "deploy", "deploy-check", "branch-survey", "close", "release"];

function acrossRepos(calls: Call[]) {
  const steps = calls.filter((c) => !c.label.startsWith("land:") && !c.label.startsWith("version:"));
  assert.deepEqual(steps.map((c) => c.label), EVERY_STEP, `the run did not reach every prompt that spans the repositories: ${calls.map((c) => c.label).join(", ")}`);
  return steps;
}

test("prompts that span repositories with different default branches name each repository's base, not a placeholder", async () => {
  const { calls, done } = lander("master", "main");
  await done;
  for (const call of acrossRepos(calls)) {
    const refs = [...call.prompt.matchAll(/origin\/(\S*)/g)].map((m) => m[1] ?? "");
    const unresolved = refs.filter((ref) => !/^(master|main)\)?$/.test(ref));
    assert.deepEqual(unresolved, [], `the ${call.label} step names a remote branch nobody has: ${unresolved.join(", ")}\n${call.prompt}`);
    assert.equal(call.prompt.includes("<default branch>"), false, `the ${call.label} step hands the session a placeholder to guess at`);
    assert.ok(call.prompt.includes("acme/app  origin/master"), `the ${call.label} step does not say which base acme/app commits are built on`);
    assert.ok(call.prompt.includes("acme/site  origin/main"), `the ${call.label} step does not say which base acme/site commits are built on`);
  }
  for (const call of calls.filter((c) => c.label.startsWith("land:acme/app") || c.label.startsWith("version:acme/app"))) {
    assert.equal(call.prompt.includes("origin/main"), false, `the ${call.label} step is told about another repository's base`);
    assert.equal(call.prompt.includes("<default branch>"), false, `the ${call.label} step hands the session a placeholder to guess at`);
  }
  for (const call of calls.filter((c) => c.label.startsWith("land:acme/site") || c.label.startsWith("version:acme/site"))) {
    assert.equal(call.prompt.includes("origin/master"), false, `the ${call.label} step is told about another repository's base`);
  }
});

const ONE_BASE = 'git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" commit -F <message file>';

test("prompts are unchanged when every repository shares one default, or none is configured", async () => {
  const shared = lander("master", "master");
  const unset = lander(undefined, undefined);
  await Promise.all([shared.done, unset.done]);
  const one = acrossRepos(shared.calls);
  const none = acrossRepos(unset.calls);
  for (const [i, call] of one.entries()) {
    assert.equal(call.prompt, none[i]?.prompt, `the ${call.label} step reads differently with a shared default configured than with none`);
    assert.ok(call.prompt.includes(ONE_BASE), `the ${call.label} step no longer carries the one-line identity command:\n${call.prompt}`);
    assert.equal(call.prompt.includes("acme/app  origin/"), false, `the ${call.label} step lists bases per repository when they all share one`);
    assert.equal(call.prompt.includes("<default branch>"), false);
  }
});
