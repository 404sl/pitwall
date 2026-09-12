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
    lockToken: TOKEN,
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
    if (n === 1) return { status: "taken", holder: TOKEN };
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

type Result = {
  landed?: number[];
  deployed?: string;
  closed?: string;
  unclosed?: number[];
  heldBack?: number[];
};

function trainWith(steps: Record<string, unknown>, site: Record<string, unknown> = CONFIGURED) {
  return runScript("land-train.js", argsFor(site), (call, n) => {
    if (n === 1) return { status: "taken", holder: TOKEN };
    if (call.label in steps) return steps[call.label];
    return landed(call, n);
  });
}

async function ran(steps: Record<string, unknown>, site: Record<string, unknown> = CONFIGURED) {
  const { calls, logs, done } = trainWith(steps, site);
  const out = (await done) as Result;
  return { out, calls, logs };
}

test("the deploy step is given a schema, so its answer is something the train can read", async () => {
  const { calls } = await ran({});
  const deploy = calls.find((c) => c.label === "deploy");

  assert.ok(deploy, "no deploy step ran");
  assert.ok(
    deploy.schema && deploy.schema.properties && deploy.schema.properties.status,
    "the deploy step carries no schema, so whatever it reports is discarded and the close step " +
      "runs regardless - a deploy that failed, reported partial, or was killed is then " +
      "indistinguishable from one that worked.",
  );
  assert.deepEqual(
    deploy.schema.properties.status.enum,
    ["deployed", "partial", "failed", "not_needed"],
    "the deploy status is not a closed set of answers, so nothing can be gated on it",
  );
});

test("a deploy that failed closes nothing, and the run says which pull requests it left open", async () => {
  const { out, calls, logs } = await ran({
    deploy: { status: "failed", notes: "staging is still serving the previous release" },
  });

  assert.equal(out.deployed, "failed");
  assert.ok(
    !calls.some((c) => c.label === "close"),
    "the close step ran after a failed deploy, so the train closed issues as landed-and-deployed " +
      "when nothing deployed",
  );
  assert.deepEqual(out.heldBack, [1287], "the run does not name what it left open");
  assert.equal(out.closed, "not_attempted");
  assert.ok(
    logs.some((l) => l.includes("404sl/pitwall#1287") && /stay open|left open/.test(l)),
    `nothing in the run says which pull requests are open and what to check:\n${logs.join("\n")}`,
  );
});

test("a deploy that reports nothing is settled by reading the hosts back, not guessed at", async () => {
  const { out, calls } = await ran({
    deploy: undefined,
    "deploy-check": {
      status: "read",
      hosts: [
        { environment: "staging", revision: SHA },
        { environment: "production", revision: SHA },
      ],
      notes: "",
    },
  });

  assert.ok(
    calls.some((c) => c.label === "deploy-check"),
    "a silent deploy step was not followed by a read of the hosts, so the answer was guessed",
  );
  assert.equal(out.deployed, "deployed");
  assert.ok(calls.some((c) => c.label === "close"), "the hosts confirmed the merge sha and nothing closed");
});

test("a deploy that reports nothing is not rendered as a failure when the hosts cannot settle it", async () => {
  const { out, calls, logs } = await ran({ deploy: undefined, "deploy-check": undefined });

  assert.equal(
    out.deployed,
    "unknown",
    "a deploy step that reported nothing was rendered as something it did not say. Silence is " +
      "ignorance, not failure, and reporting it as failure sends somebody to fix a deploy that " +
      "may well have worked.",
  );
  assert.notEqual(out.deployed, "failed");
  assert.ok(!calls.some((c) => c.label === "close"), "an unknown deploy still closed issues");
  assert.ok(
    logs.some((l) => l.includes("THIS IS NOT A FAILURE")),
    `the run does not distinguish an unknown deploy from a failed one:\n${logs.join("\n")}`,
  );
});

test("a deploy step claiming not_needed for a repository that deploys is not taken at its word", async () => {
  const { out, calls } = await ran({ deploy: { status: "not_needed", notes: "" }, "deploy-check": undefined });

  assert.equal(
    out.deployed,
    "unknown",
    "the deploy step was allowed to declare there was nothing to deploy for a repository whose " +
      "config records deploy commands. That is the config's answer to give, and trusting the " +
      "step's opens the close gate on the one report that means nobody looked.",
  );
  assert.ok(!calls.some((c) => c.label === "close"));
});

test("a repository with no deploy closes on the merge alone", async () => {
  const { out, calls } = await ran({}, { deploy: [] });

  assert.equal(out.deployed, "not_needed");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close, "a repository with nothing to deploy to never closed its issues, so they sit in_progress");
  assert.ok(
    /no deploy to be live in/.test(close.prompt),
    `the close brief still claims a deploy that never happened:\n${close.prompt}`,
  );
});

test("a close step that reports nothing leaves the pull requests named, not counted as closed", async () => {
  const { out, logs } = await ran({
    deploy: { status: "deployed", notes: "", environments: [{ environment: "staging", revision: SHA }] },
    close: undefined,
  });

  assert.equal(out.deployed, "deployed");
  assert.equal(out.closed, "unknown");
  assert.deepEqual(
    out.unclosed,
    [1287],
    "a killed close step is indistinguishable from one that closed everything, so the issue sits " +
      "in_progress with nothing reporting it",
  );
  assert.ok(
    logs.some((l) => l.includes("404sl/pitwall#1287")),
    `the run does not name what went unconfirmed:\n${logs.join("\n")}`,
  );
});

test("a close step confirming only some of what landed reports the rest", async () => {
  const { out } = await ran({
    deploy: { status: "deployed", notes: "", environments: [] },
    "build:full": { status: "built", trainPr: 120, trainBranch: "release/train-1", included: [1287, 1290], skipped: [] },
    close: { status: "partial", closed: [{ pr: 1287, issue: "pitwall-80o" }], notes: "1290 named no issue" },
  });

  assert.equal(out.closed, "partial");
  assert.deepEqual(out.unclosed, [1290]);
});
