import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "lander-1788964650-29574",
  repos: {
    docs: {
      path: "site",
      slug: "owner/site",
      deploy: ["bash deploy-one.sh --label staging"],
      verify: "curl -s -m 20 https://staging.example.com/health",
    },
  },
};

const LATER = "4c7b2f1099aa33e1b0d7e4c5a6b8d90123456789";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

const PR = { slug: "owner/site", number: 16, title: "Rewrite the headline", branch: "devloop/pitwall-7b1", issue: "pitwall-7b1" };
const SECOND = { slug: "owner/site", number: 17, title: "Rewrite the subhead", branch: "devloop/pitwall-7b2", issue: "pitwall-7b2" };

type Replies = { deploy?: unknown; check?: unknown; close?: unknown; prs?: unknown[]; args?: unknown };

function hosts(revision: string, repo = "docs", environment = "only") {
  return [{ repo, environment, revision }];
}

const TWO_ENV = {
  ...ARGS,
  repos: {
    docs: {
      ...ARGS.repos.docs,
      deploy: ["bash deploy-one.sh --label staging", "bash deploy-one.sh --label production"],
      verify: {
        staging: "curl -s -m 20 https://staging.example.com/health",
        production: "curl -s -m 20 https://example.com/health",
      },
    },
  },
};

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

function landOnce(replies: Replies) {
  const queue = replies.prs || [PR];
  const shas: Record<string, string> = { "owner/site#16": SHA, "owner/site#17": LATER };
  return runScript("land.js", replies.args || ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: queue } : { prs: [] };
    if (call.label.startsWith("version:")) return NO_PLUGIN;
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: shas[call.label.slice(5)] || SHA, masterGreen: true, notes: "" };
    if (call.label === "deploy") return replies.deploy;
    if (call.label === "deploy-check") return replies.check;
    if (call.label === "close") return replies.close;
    return { status: "released" };
  });
}

test("a deploy step that reported nothing is not called failed", async () => {
  const { calls, logs, done } = landOnce({ deploy: null, check: null });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "failed",
    "a killed deploy step was reported as a failed deploy. The deploy it described had succeeded, " +
      "and re-running a deploy on the strength of that word is the obvious wrong response to it.",
  );
  assert.equal(result.deployed, "unknown");

  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(check, `nothing read the hosts back when the deploy step did not report. Steps: ${calls.map((c) => c.label).join(", ")}`);
  assert.ok(
    check.prompt.includes("https://staging.example.com/health"),
    "the read-back was not given the host to read",
  );

  const said = logs.join("\n");
  assert.match(said, /UNKNOWN/);
  assert.match(said, /pitwall-7b1/);
  assert.ok(
    said.includes("https://staging.example.com/health"),
    `an unknown deploy must say what to check, and the verify command is it. Logged:\n${said}`,
  );
});

test("the read-back is never told the answer it is being asked to produce", async () => {
  const { calls, done } = landOnce({ deploy: null, check: null });
  await done;

  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(check);
  assert.ok(
    !check.prompt.includes(SHA.slice(0, 12)),
    "the read-back's brief carries the sha the caller will compare against. A step handed the expected " +
      "answer can satisfy its brief by quoting it back without reading any host, which is the failure " +
      "this whole read-back exists to remove - and its reply closes issues unattended.",
  );
  assert.doesNotMatch(
    check.prompt,
    /[0-9a-f]{12,}/i,
    "the read-back's brief contains a revision-shaped string. It must describe no value the caller compares against.",
  );
});

test("two repositories' worth of merges do not put either sha in the read-back brief", async () => {
  const { calls, done } = landOnce({ prs: [PR, SECOND], deploy: null, check: null });
  await done;

  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(check);
  for (const sha of [SHA, LATER]) {
    assert.ok(!check.prompt.includes(sha.slice(0, 12)), `the read-back brief names ${sha.slice(0, 12)}`);
  }
});

test("reading the hosts back is what decides an unreported deploy", async () => {
  const { calls, logs, done } = landOnce({
    deploy: null,
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(result.deployed, "deployed", "the host was serving the merged sha and the run still did not call it deployed");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close, "nothing was closed for a deploy the hosts confirmed");
  assert.ok(close.prompt.includes("pitwall-7b1"));
  assert.match(logs.join("\n"), /closed 1 issue/);
});

test("a host serving something other than the merged sha is a failure, whatever was killed", async () => {
  const { done } = landOnce({ deploy: null, check: { status: "read", hosts: hosts("0123456789ab"), notes: "still on the old revision" } });
  const result = await done;
  assert.equal(result.deployed, "failed");
});

test("a deploy the agent reports as failed stays failed, and is not read back", async () => {
  const { calls, done } = landOnce({ deploy: { status: "failed", notes: "mina refused: another deployment is ongoing" } });
  const result = await done;

  assert.equal(result.deployed, "failed", "a step that reported failure has told us something and that must not be softened");
  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    0,
    "the hosts were read back after a deploy that reported its own failure - the read-back is for silence, not for a reported error",
  );
});

test("a close step that reported nothing names the issues it left in_progress", async () => {
  const { logs, done } = landOnce({
    deploy: { status: "deployed", hosts: hosts(SHA), notes: "" },
    close: null,
  });
  const result = await done;

  assert.equal(result.closed, "unknown");
  assert.deepEqual(
    result.unclosed,
    ["pitwall-7b1"],
    "the close step was killed and nothing reported which merged-and-deployed issues were left open. " +
      "Four of them sat in_progress for hours that way and were found only by going to look.",
  );
  assert.match(logs.join("\n"), /pitwall-7b1/);
});

test("a close step that reports the ids it closed is not reported as drift", async () => {
  const { logs, done } = landOnce({
    deploy: { status: "deployed", hosts: hosts(SHA), notes: "" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(result.closed, "closed");
  assert.deepEqual(result.unclosed, []);
  assert.doesNotMatch(logs.join("\n"), /CLOSE UNKNOWN/);
});

test("a host serving another revision is not a deploy, however the read-back was worded", async () => {
  const { calls, logs, done } = landOnce({
    deploy: null,
    check: { status: "read", hosts: hosts(OTHER), notes: "it answered" },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the host was serving a revision that is not the one this run merged and the run called it deployed anyway. " +
      "Nothing in code had compared the sha the step handed back.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed as deployed while the host was serving another revision",
  );
  assert.match(logs.join("\n"), new RegExp(SHA.slice(0, 12)));
});

test("a host still serving an earlier merge from the same run is not deployed", async () => {
  const { calls, done } = landOnce({
    prs: [PR, SECOND],
    deploy: null,
    check: { status: "read", hosts: hosts(SHA), notes: "a sha that is on master" },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the host was serving the first of two merges - genuinely on the default branch, and missing the change after it - and the run read that as deployed.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
});

test("a host that did not answer is unknown, never a failure", async () => {
  const { calls, done } = landOnce({ deploy: null, check: { status: "unreadable", hosts: hosts(""), notes: "the endpoint timed out" } });
  const result = await done;

  assert.equal(
    result.deployed,
    "unknown",
    "a host that said nothing was rendered as a deploy that failed - the same collapse of silence into failure this release is about, one level down.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
});

test("a read-back that could not read its hosts does not confirm a deploy by naming a sha", async () => {
  const { done } = landOnce({ deploy: null, check: { status: "unreadable", hosts: hosts(SHA), notes: "guessed from git" } });
  const result = await done;

  assert.equal(
    result.deployed,
    "unknown",
    "the step said it could not read the hosts and handed back the merged sha regardless, and the run promoted that to deployed. " +
      "A revision nothing read is not evidence, and the contradiction resolves in favour of holding the issues open.",
  );
});

test("a repository the read-back did not report on is unknown, not deployed", async () => {
  const { done } = landOnce({ deploy: null, check: { status: "read", hosts: hosts(SHA, "elsewhere"), notes: "" } });
  const result = await done;

  assert.equal(
    result.deployed,
    "unknown",
    "the read-back reported a revision against a repository that did not land, nothing was said about the one that did, and the run still resolved the deploy.",
  );
});

test("a read-back with no endpoint to read is never run and never deployed", async () => {
  const noVerify = { ...ARGS, repos: { docs: { ...ARGS.repos.docs, verify: undefined } } };
  const { calls, logs, done } = landOnce({ args: noVerify, deploy: null, check: { status: "read", hosts: hosts(SHA), notes: "" } });
  const result = await done;

  assert.equal(
    result.deployed,
    "unknown",
    "the landed repository deploys and records no verify command, so nothing could read a host back - and the run still resolved the deploy.",
  );
  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    0,
    "a read-back was spawned with no host to read. Its only instruction is to run a list of commands, and an empty list leaves an agent asked for revisions with no way to get any.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
  assert.match(logs.join("\n"), /no verify command/);
});

test("a run that closed everything it could says so quietly when nothing named an issue", async () => {
  const { logs, done } = landOnce({
    prs: [{ ...PR, issue: undefined }],
    deploy: { status: "deployed", hosts: hosts(SHA), notes: "" },
    close: { status: "none", closed: [] },
  });
  const result = await done;

  assert.deepEqual(result.unclosed, []);
  assert.doesNotMatch(
    logs.join("\n"),
    /CLOSE/,
    "a pull request that named no tracker issue is a designed state, and the run raised a loud CLOSE line about zero issues. Red means a lane needs a person.",
  );
});

test("one environment reporting the merge sha does not confirm a repository that deploys to two", async () => {
  const { calls, done } = landOnce({
    args: TWO_ENV,
    deploy: null,
    check: { status: "read", hosts: [{ repo: "docs", environment: "staging", revision: SHA }], notes: "staging answered" },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "staging confirmed the merge, production said nothing, and the run treated one environment as both. " +
      "A change live in one environment and not the other is live in neither, and closing its issues says it shipped.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed as deployed on one of two environments",
  );
});

test("every environment reporting the merge sha confirms a repository that deploys to two", async () => {
  const { calls, done } = landOnce({
    args: TWO_ENV,
    deploy: null,
    check: {
      status: "read",
      hosts: [
        { repo: "docs", environment: "staging", revision: SHA },
        { repo: "docs", environment: "production", revision: SHA },
      ],
      notes: "both answered",
    },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(
    result.deployed,
    "deployed",
    "both environments were serving the merged sha and the run still would not call it deployed - which would leave every " +
      "successful multi-environment deploy reporting unknown forever.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
});

test("a read-back brief names every environment a landed repository deploys to", async () => {
  const { calls, done } = landOnce({ args: TWO_ENV, deploy: null, check: null });
  await done;

  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(check, "no read-back was spawned for a repository with a command per environment");
  for (const env of ["staging", "production"]) {
    assert.ok(check.prompt.includes(env), `the read-back was not asked about ${env}. Asked:\n${check.prompt}`);
  }
  assert.ok(check.prompt.includes("https://example.com/health"));
});

test("two entries for one environment reach the same verdict in either order", async () => {
  const stale = { repo: "docs", environment: "only", revision: OTHER };
  const fresh = { repo: "docs", environment: "only", revision: SHA };

  const first = await landOnce({ deploy: null, check: { status: "read", hosts: [stale, fresh], notes: "" } }).done;
  const second = await landOnce({ deploy: null, check: { status: "read", hosts: [fresh, stale], notes: "" } }).done;

  assert.equal(
    first.deployed,
    second.deployed,
    "the same two observations in the reverse order produced a different verdict. One order closes the tracker issues " +
      "while a host is serving something else, and nothing about the hosts changed between the two runs.",
  );
  assert.notEqual(
    first.deployed,
    "deployed",
    "one environment answered twice and disagreed with itself, and the run resolved that to deployed. Two contradictory " +
      "answers are not an answer.",
  );
});

test("a repository with a verify command and no deploy is never read back", async () => {
  const alsoSite = {
    ...ARGS,
    repos: {
      docs: ARGS.repos.docs,
      site: { path: "cli", slug: "owner/cli", verify: "curl -s -m 20 https://api.example.com/revision" },
    },
  };
  const inSite = { slug: "owner/cli", number: 18, title: "Read the lock back", branch: "devloop/pitwall-7b3", issue: "pitwall-7b3" };
  const { calls, done } = landOnce({
    args: alsoSite,
    prs: [PR, inSite],
    deploy: null,
    check: { status: "read", hosts: hosts(SHA), notes: "" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(check);
  assert.ok(
    !check.prompt.includes("https://api.example.com/revision"),
    "the read-back was asked about a repository that does not deploy. Its host has no deploy behind it, cannot answer " +
      "for one, and its non-answer drags the whole run to unknown while every deploying host matched.",
  );
  assert.equal(
    result.deployed,
    "deployed",
    "every deploying repository was serving its merge sha and a repository with nothing to deploy held the run at unknown",
  );
});

test("a verify command that does not name every environment spawns no read-back", async () => {
  const oneCommandTwoEnvironments = {
    ...ARGS,
    repos: { docs: { ...TWO_ENV.repos.docs, verify: "curl -s -m 20 https://staging.example.com/health" } },
  };
  const { calls, logs, done } = landOnce({
    args: oneCommandTwoEnvironments,
    deploy: null,
    check: { status: "read", hosts: hosts(SHA), notes: "" },
  });
  const result = await done;

  assert.equal(
    result.deployed,
    "unknown",
    "a repository deploying to two environments records one command to read a host back with, so one of the two can never " +
      "be confirmed - and the run resolved the deploy anyway.",
  );
  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    0,
    "a read-back was spawned for a repository whose environments cannot all be read. The verdict is unknown whatever it " +
      "reports, so the step only costs a session.",
  );
  const said = logs.join("\n");
  assert.match(said, /docs/);
  assert.match(
    said,
    /one command per environment/,
    `the log must say what to configure, because the config is in the root repository no lane is dispatched into. Logged:\n${said}`,
  );
});

test("the close step is distinguishable from a close step that never ran", async () => {
  const { done } = landOnce({ deploy: null, check: { status: "read", hosts: hosts(OTHER), notes: "" } });
  const result = await done;

  assert.equal(result.deployed, "failed");
  assert.equal(
    result.closed,
    null,
    "the close step never ran and the result says 'not_needed', which reads to anything downstream as 'there was nothing " +
      "to close'. This ticket exists because those two states were conflated once already.",
  );
});

test("the merge sha a host is compared against is described as the squash commit", async () => {
  const { calls, done } = landOnce({ deploy: { status: "deployed", hosts: hosts(SHA), notes: "" }, close: { status: "closed", closed: ["pitwall-7b1"] } });
  await done;

  const land = calls.find((c) => c.label.startsWith("land:"));
  assert.ok(land && land.schema, "the land step was spawned with no schema");
  const described = land.schema.properties.mergeSha.description;
  assert.match(described, /DEFAULT BRANCH/i);
  assert.match(described, /never the pull request head/i);
});

test("the deploy step keeps its own read-back command when the verify shape cannot key the environments", async () => {
  const oneCommandTwoEnvironments = {
    ...ARGS,
    repos: { docs: { ...TWO_ENV.repos.docs, verify: ARGS.repos.docs.verify } },
  };
  const { calls, done } = landOnce({ args: oneCommandTwoEnvironments, deploy: null, check: null });
  await done;

  const deploy = calls.find((c) => c.label === "deploy");
  assert.ok(deploy, `no deploy step was spawned. Steps: ${calls.map((c) => c.label).join(", ")}`);
  assert.ok(
    deploy.prompt.includes("https://staging.example.com/health"),
    "the deploy step was no longer given the command that reads a host back. Whether the read-back step can key a " +
      "configured verify per environment is a question about the read-back step; the deploy step's own instruction to " +
      "check what it just shipped does not depend on it, and that step's word is what still promotes a deploy.",
  );
  for (const line of ["repos.docs.verify", "can never be confirmed", "records no verify command"]) {
    assert.ok(
      !deploy.prompt.includes(line),
      `the deploy step's brief carries '${line}', which is a line for a person reading the log. It tells an agent with ` +
        "tools and a checkout to edit configuration, in a brief that also forbids touching the main working tree.",
    );
  }
});

test("a repository with no verify command keeps the deploy step's fallback instruction", async () => {
  const noVerify = {
    ...ARGS,
    repos: { docs: { path: "site", slug: "owner/site", deploy: TWO_ENV.repos.docs.deploy } },
  };
  const { calls, done } = landOnce({ args: noVerify, deploy: null, check: null });
  await done;

  const deploy = calls.find((c) => c.label === "deploy");
  assert.ok(deploy);
  assert.match(
    deploy.prompt,
    /Work out what the deployed\s+version is by whatever means the project offers/,
    "the deploy step lost the instruction to establish what is live by whatever means exist, which is the only thing " +
      "standing behind an unconfigured repository's deploy report.",
  );
  assert.ok(
    !deploy.prompt.includes("repos.docs.verify") && !deploy.prompt.includes("nothing here can read what its"),
    "the deploy step was handed a sentence saying nothing can read what its environments serve, in place of the " +
      "instruction to find out. That replaces a task with a statement that the task is impossible.",
  );
});

test("a deploy step that reports deployed while serving another revision closes nothing", async () => {
  const { calls, logs, done } = landOnce({
    deploy: { status: "deployed", hosts: hosts(OTHER), notes: "deployed and verified" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the deploy step said it deployed while its own read-back named a revision that is not what merged, and the run " +
      "took the word and discarded the evidence beside it. The silent path has compared those shas since 0.1.20; the " +
      "reported path is the ordinary one and was the only one still unchecked.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed as deployed while the host the deploy step read was serving another revision",
  );

  const said = logs.join("\n");
  assert.match(said, new RegExp(OTHER.slice(0, 12)), "the log does not say what the host is serving");
  assert.match(said, new RegExp(SHA.slice(0, 12)), "the log does not say what merged");
  assert.match(said, /docs/, "the log does not say which repository is serving it");
});

test("a deploy step that reports deployed and names the merged sha closes its issues", async () => {
  const { calls, logs, done } = landOnce({
    deploy: { status: "deployed", hosts: hosts(SHA), notes: "deployed and verified" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(
    result.deployed,
    "deployed",
    "the host the deploy step read was serving the merge sha and the run still would not call it deployed - which would " +
      "hold every ordinary successful run's issues open forever.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
  assert.match(logs.join("\n"), new RegExp(`deploy: deployed docs only ${SHA.slice(0, 8)}`));
});

test("a deploy step that reports deployed and names no revision is read back rather than believed", async () => {
  const { calls, done } = landOnce({
    deploy: { status: "deployed", hosts: [], notes: "mina said done" },
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.ok(
    calls.find((c) => c.label === "deploy-check"),
    "a deploy step reported deployed with nothing to compare against what merged, and no host was read back. " +
      `Steps: ${calls.map((c) => c.label).join(", ")}`,
  );
  assert.equal(
    result.deployed,
    "deployed",
    "the blind read-back found the merge sha live and the run did not resolve the deploy, so a step that answers the " +
      "status and forgets the hosts would strand its issues.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
});

test("a deploy step that reports deployed on one of two environments is not deployed", async () => {
  const { calls, done } = landOnce({
    args: TWO_ENV,
    deploy: { status: "deployed", hosts: [{ repo: "docs", environment: "staging", revision: SHA }], notes: "staging is live" },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the deploy step reported one of the two environments it deploys to and called the whole thing deployed. A change " +
      "live in one environment and not the other is live in neither.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
});

test("the deploy step is told which repository and environment each read-back line belongs to", async () => {
  const { calls, done } = landOnce({ args: TWO_ENV, deploy: null, check: null });
  await done;

  const deploy = calls.find((c) => c.label === "deploy");
  assert.ok(deploy);
  for (const line of ["docs  staging  curl", "docs  production  curl"]) {
    assert.ok(
      deploy.prompt.includes(line),
      `the deploy brief does not name the repository and environment beside its read-back commands, so nothing it reports ` +
        `can be matched to a host. Expected a line carrying '${line}'. Asked:\n${deploy.prompt}`,
    );
  }
});

test("a deploy step reading one unkeyed host is told the environment name the comparison uses", async () => {
  const { calls, done } = landOnce({ deploy: null, check: null });
  await done;

  const deploy = calls.find((c) => c.label === "deploy");
  assert.ok(deploy);
  assert.ok(
    deploy.prompt.includes("docs  only  curl"),
    `a repository whose verify is a single command has one environment, and the comparison keys it by the name this brief ` +
      `prints. A brief that prints no name gets an invented one back, which matches no host. Asked:\n${deploy.prompt}`,
  );
});

test("the deploy step's schema carries the hosts its status is checked against", async () => {
  const { calls, done } = landOnce({ deploy: { status: "deployed", hosts: hosts(SHA), notes: "" }, close: { status: "closed", closed: ["pitwall-7b1"] } });
  await done;

  const deploy = calls.find((c) => c.label === "deploy");
  assert.ok(deploy && deploy.schema, "the deploy step was spawned with no schema");
  const properties = deploy.schema.properties;
  assert.ok(
    properties.hosts,
    "the deploy step is asked for a status and no per-repository revision, so a staging/production pair cannot be " +
      "attributed to the repositories that landed and nothing can compare it.",
  );
  for (const field of ["repo", "environment", "revision"]) {
    assert.ok(properties.hosts.items.properties[field], `a reported host carries no ${field}`);
  }
});
