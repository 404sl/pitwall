import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const CLI_SHA = "f58c5471aa2b3c4d5e6f708192a3b4c5d6e7f809";
const SITE_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

const MAPPING = "**`site` means `cli` and `integration` means `schema`.** Read `site` as the primary deliverable.\n";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "lander-close-verdict-"));
  writeFileSync(join(root, "CLAUDE.md"), `# Workspace\n\n${MAPPING}`);
  return root;
}

function args(root: string) {
  return {
    skillDir: "/skill",
    root,
    lockToken: "lander-1788964650-29574",
    repos: {
      cli: { path: "cli", slug: "owner/pitwall", test: "npm test" },
      site: {
        path: "site",
        slug: "owner/pitwall-site",
        deploy: ["bash deploy-one.sh --label staging"],
        verify: { staging: "curl -s -m 20 https://staging.example.com/health" },
      },
    },
  };
}

const CLI_PR = { slug: "owner/pitwall", number: 135, title: "Give the Problems table a column template", branch: "devloop/pitwall-025b", issue: "pitwall-025b" };
const SITE_PR = { slug: "owner/pitwall-site", number: 12, title: "Rewrite the headline", branch: "devloop/pitwall-7b1", issue: "pitwall-7b1" };

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

type Replies = { prs: typeof CLI_PR[]; deploy?: unknown; check?: unknown; close?: unknown };

function land(root: string, replies: Replies) {
  const a = args(root);
  const asked = Object.values(a.repos).flatMap((r) => replies.prs.map((pr) => ({ slug: r.slug, branch: pr.branch })));
  const shas: Record<string, string> = { "owner/pitwall#135": CLI_SHA, "owner/pitwall-site#12": SITE_SHA };
  return runScript("land.js", a, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: a.lockToken, holder: a.lockToken };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: replies.prs } : { prs: [] };
    if (call.label.startsWith("version:")) return NO_PLUGIN;
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: shas[call.label.slice(5)], masterGreen: true, notes: "" };
    if (call.label === "branch-survey") return { status: "read", asked, prs: [] };
    if (call.label === "deploy") return replies.deploy;
    if (call.label === "deploy-check") return replies.check;
    if (call.label === "close") return replies.close;
    return { status: "released" };
  });
}

test("a merged cli pull request closes on the merge when cli has no deploy array, whatever the root says site means", async () => {
  const root = workspace();
  const { calls, logs, done } = land(root, {
    prs: [CLI_PR],
    deploy: { status: "not_needed", hosts: [], notes: "nothing here deploys" },
    close: { status: "closed", closed: ["pitwall-025b"] },
  });
  const result = await done;

  assert.equal(result.deployed, "not_needed");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close, `the close step never ran for a repository with nothing to deploy:\n${logs.join("\n")}`);
  assert.match(close.prompt, /bd close pitwall-025b --reason "Landed in owner\/pitwall#135 - cli has no deploy configured, closed on the merge"/);
  assert.match(close.prompt, /config key: cli\n/, "the key the pull request was pre-flighted under is not printed beside it");
  assert.match(close.prompt, /cli has no deploy array in this run's config/, "the prompt does not say, as data, that cli has no deploy");
  assert.match(close.prompt, /verdict: merged, nothing to deploy - CLOSE/);
  assert.doesNotMatch(close.prompt, /Only these repositories have a\s+deploy command configured/, "the prompt still lists deploying keys by name for the agent to map slugs onto");
  assert.doesNotMatch(close.prompt, /IF THE DEPLOY DID NOT SUCCEED, CLOSE NOTHING/, "a run-wide deploy rule is still there to be weighed against a per-issue verdict");
  assert.doesNotMatch(close.prompt, /CLAUDE\.md|README|AGENTS\.md/i, "the close step is invited to read prose to decide what deploys");
  assert.doesNotMatch(close.prompt, /config key: site\b/, "a key that has nothing to do with this issue is named in its close brief");
  assert.match(logs.join("\n"), /closed 1 issue\(s\) - pitwall-025b/);
});

test("a merged site pull request whose deploy did not succeed is held, and a cli one landed beside it still closes", async () => {
  const root = workspace();
  const { calls, logs, done } = land(root, {
    prs: [CLI_PR, SITE_PR],
    deploy: { status: "failed", hosts: [], notes: "mina exited 1" },
    close: { status: "closed", closed: ["pitwall-025b"] },
  });
  const result = await done;

  assert.equal(result.deployed, "failed");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close, "the cli issue was held behind a deploy its repository does not have");
  assert.match(close.prompt, /bd close pitwall-025b/);
  assert.doesNotMatch(close.prompt, /pitwall-7b1|owner\/pitwall-site#12/, "an issue whose deploy failed was handed to the close step");
  assert.match(logs.join("\n"), /deploy failed - staying open until it is live: pitwall-7b1/);
});

test("a merged site pull request alone with a failed deploy closes nothing", async () => {
  const root = workspace();
  const { calls, logs, done } = land(root, {
    prs: [SITE_PR],
    deploy: { status: "failed", hosts: [], notes: "mina exited 1" },
  });
  const result = await done;

  assert.equal(result.deployed, "failed");
  assert.equal(calls.filter((c) => c.label === "close").length, 0, `a failed deploy still reached the close step:\n${logs.join("\n")}`);
  assert.match(logs.join("\n"), /staying open until it is live: pitwall-7b1/);
});

test("a merged site pull request whose deploy succeeded closes as deployed, beside a cli one closed on the merge", async () => {
  const root = workspace();
  const { calls, done } = land(root, {
    prs: [CLI_PR, SITE_PR],
    deploy: { status: "deployed", hosts: [{ repo: "site", environment: "staging", revision: SITE_SHA }], notes: "live" },
    close: { status: "closed", closed: ["pitwall-025b", "pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(result.deployed, "deployed");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close);
  assert.match(close.prompt, /bd close pitwall-7b1 --reason "Landed in owner\/pitwall-site#12 and deployed"/);
  assert.match(close.prompt, /config key: site\n\s+deploy: site has a deploy array in this run's config, and this run's deploy step came back deployed/);
  assert.match(close.prompt, /verdict: merged, deploy succeeded - CLOSE/);
  assert.match(close.prompt, /bd close pitwall-025b --reason "Landed in owner\/pitwall#135 - cli has no deploy configured, closed on the merge"/);
  assert.match(close.prompt, /gh pr view 135 --repo owner\/pitwall --json body/);
  assert.match(close.prompt, /gh pr view 12 --repo owner\/pitwall-site --json body/);
});

test("a host serving something other than what merged holds the site issue and still closes the cli one", async () => {
  const root = workspace();
  const { calls, done } = land(root, {
    prs: [CLI_PR, SITE_PR],
    deploy: null,
    check: { status: "read", hosts: [{ repo: "site", environment: "staging", revision: OTHER }], notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-025b"] },
  });
  const result = await done;

  assert.equal(result.deployed, "failed");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close);
  assert.match(close.prompt, /bd close pitwall-025b/);
  assert.doesNotMatch(close.prompt, /pitwall-7b1/);
});
