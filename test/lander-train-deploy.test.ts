import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call, type Reply } from "./support/workflow.js";

const STAGING = "bash /plugin/devloop/skills/devloop/deploy-one.sh --label staging --repo-path /root/cli --deploy 'bundle exec cap staging deploy' --revision 'curl -s -m 20 https://staging.pitwall.build/health | jq -r .git_revision' --timeout 1500";
const PRODUCTION = "bash /plugin/devloop/skills/devloop/deploy-one.sh --label production --repo-path /root/cli --deploy 'bundle exec cap production deploy' --revision 'curl -s -m 20 https://pitwall.build/health | jq -r .git_revision' --timeout 1500";

const TOKEN = "land-train-1788964650-29574";
const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";

function argsFor(site: Record<string, unknown>) {
  return {
    skillDir: "/skill",
    root: "/root",
    repo: "site",
    repos: {
      site: { path: "cli", slug: "404sl/pitwall", ...site },
      docs: { path: "site", slug: "404sl/pitwall-site" },
    },
  };
}

const landed: Reply = (call: Call) => {
  if (call.label.startsWith("build:")) {
    return { status: "built", trainPr: 120, trainBranch: "release/train-1", included: [1287], skipped: [] };
  }
  if (call.label.startsWith("verify:")) return { status: "green", failingSpecs: [] };
  if (call.label.startsWith("version:")) {
    return {
      status: "no_manifest",
      masterVersion: "",
      branchVersion: "",
      touchesPlugin: false,
      notes: "this repository carries no devloop plugin manifest on master",
    };
  }
  if (call.label.startsWith("merge:")) return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
  if (call.label === "left-behind") {
    return { repos: [{ repo: "site", status: "read", labelled: [1287] }] };
  }
  return { status: "released" };
};

async function deployBrief(site: Record<string, unknown>) {
  const { calls, done } = runScript("land-train.js", argsFor(site), (call, n) => {
    if (n === 1) return { status: "taken", token: TOKEN, holder: TOKEN };
    return landed(call, n);
  });
  await done;
  const call = calls.find((c) => c.label === "deploy");
  assert.ok(call, `no deploy step ran: ${calls.map((c) => c.label).join(", ")}`);
  return call.prompt;
}

const CONFIGURED = {
  deploy: [STAGING, PRODUCTION],
  verify: {
    staging: "curl -s -m 20 https://staging.pitwall.build/health | jq -r .git_revision",
    production: "curl -s -m 20 https://pitwall.build/health | jq -r .git_revision",
  },
};

test("the deploy brief carries no placeholder host and no hand-written skills path", async () => {
  const prompt = await deployBrief(CONFIGURED);

  assert.ok(
    !prompt.includes("example.com"),
    "the deploy brief names example.com, a domain nobody owns. The read-back that decides whether " +
      "a deploy happened cannot fail against it, and a check that cannot fail is not running - " +
      "which is how a train promotes a deploy on its own word.",
  );
  assert.ok(
    !prompt.includes("~/.claude/skills"),
    "the deploy brief points at ~/.claude/skills, which is not where the plugin installs. The " +
      "agent improvises when the path does not resolve, so the failure is silent rather than loud.",
  );
});

test("the deploy brief runs the commands the config records, in the order it records them", async () => {
  const prompt = await deployBrief(CONFIGURED);

  assert.ok(prompt.includes(STAGING), `the configured staging deploy is not in the brief:\n${prompt}`);
  assert.ok(prompt.includes(PRODUCTION), `the configured production deploy is not in the brief:\n${prompt}`);
  assert.ok(
    prompt.indexOf(STAGING) < prompt.indexOf(PRODUCTION),
    "the configured order was not preserved. Staging has to be offered first: staging broken with " +
      "production already shipped is the forbidden split mirrored.",
  );
  assert.ok(
    !prompt.includes("mina"),
    "the deploy brief still names a deploy tool the config never mentioned. land-train.js ships in " +
      "a plugin other workspaces install, and one deploy command written into it deploys the wrong " +
      "thing everywhere else.",
  );
});

test("the deploy brief asks each host what it is serving with the configured read-back", async () => {
  const prompt = await deployBrief(CONFIGURED);

  for (const [environment, command] of Object.entries(CONFIGURED.verify)) {
    assert.ok(
      prompt.includes(command),
      `the brief never reads ${environment} back:\n${prompt}`,
    );
  }
});

test("a repository that records no read-back is told to work out what is live, not handed a host", async () => {
  const prompt = await deployBrief({ deploy: [STAGING, PRODUCTION] });

  assert.ok(!prompt.includes("example.com"));
  assert.ok(
    /verify|what is live|what the deployed/i.test(prompt),
    `a repository with no verify command was given no instruction to confirm the deploy:\n${prompt}`,
  );
});
