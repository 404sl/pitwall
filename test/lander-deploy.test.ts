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

test("a verify command that does not name every environment still reads back the one it names", async () => {
  const oneCommandTwoEnvironments = {
    ...ARGS,
    repos: { docs: { ...TWO_ENV.repos.docs, verify: { staging: "curl -s -m 20 https://staging.example.com/health" } } },
  };
  const { calls, logs, done } = landOnce({
    args: oneCommandTwoEnvironments,
    deploy: null,
    check: { status: "read", hosts: hosts(SHA, "docs", "staging"), notes: "" },
  });
  const result = await done;

  assert.equal(
    result.deployed,
    "unknown",
    "a repository deploying to two environments records one command to read a host back with, so one of the two can never " +
      "be confirmed - and the run resolved the deploy anyway.",
  );
  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(
    check,
    "the environment that DOES configure a command to read a host back went unread because a sibling environment " +
      "configures none. An environment nobody can ask is a gap in the configuration; it is not permission to skip the " +
      `one anybody can. Steps: ${calls.map((c) => c.label).join(", ")}`,
  );
  assert.ok(
    check.prompt.includes("https://staging.example.com/health"),
    "the read-back was spawned without the one command it can actually run",
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

test("a deploy step that reports deployed where no host can be read back still closes its issues", async () => {
  const noVerify = {
    ...ARGS,
    repos: { docs: { path: "site", slug: "owner/site", deploy: TWO_ENV.repos.docs.deploy } },
  };
  const { calls, logs, done } = landOnce({
    args: noVerify,
    deploy: { status: "deployed", hosts: [], notes: "both deployed; the project offers nothing that prints a revision" },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(
    result.deployed,
    "deployed",
    "a repository that deploys and configures no verify has no host anybody can read, so there is no revision to " +
      "contradict the step - and the run held its issues open anyway. Nothing was checked before this comparison " +
      "existed either: turning an unverifiable config into a permanent hold on a patch release is the 2026-08-25 " +
      "pile-up, issues sitting in_progress and invisible to the queue, reached by upgrading rather than by deploying.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    1,
    "the close step was never spawned for a deploy nothing was able to check, so every issue this run merged stays in_progress forever",
  );
  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    0,
    "a read-back was spawned with no host to read",
  );

  const said = logs.join("\n");
  assert.match(said, /no verify command/, "the log does not name the configuration that would have checked it");
  assert.match(
    said,
    /own word/,
    "this close rests on the step's assertion and nothing else, and the log reads like any other deployed run. A " +
      "reader must be able to tell a revision somebody compared from a status somebody asserted.",
  );
});

test("a repository nothing can read back does not launder a revision that contradicts what merged", async () => {
  const halfConfigured = {
    ...ARGS,
    repos: {
      docs: ARGS.repos.docs,
      site: { path: "cli", slug: "owner/cli", deploy: ["bash deploy-one.sh --label production"] },
    },
  };
  const inSite = { slug: "owner/cli", number: 18, title: "Read the lock back", branch: "devloop/pitwall-7b3", issue: "pitwall-7b3" };
  const { calls, logs, done } = landOnce({
    args: halfConfigured,
    prs: [PR, inSite],
    deploy: { status: "deployed", hosts: hosts(OTHER), notes: "both live" },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "one repository is serving a revision that is not what merged into it, and the run took the step's word back " +
      "because a DIFFERENT repository happened to have no verify configured. A host that answered and disagreed is " +
      "evidence; a host nobody could ask is not, and an unaskable one must not cancel out an answered one.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed while a host the deploy step read was serving another revision",
  );
  assert.match(logs.join("\n"), new RegExp(OTHER.slice(0, 12)), "the log does not say what the host is serving");
});

const HALF_CONFIGURED = {
  ...ARGS,
  repos: {
    docs: ARGS.repos.docs,
    site: { path: "cli", slug: "owner/cli", deploy: ["bash deploy-one.sh --label production"] },
  },
};

const IN_SITE = { slug: "owner/cli", number: 18, title: "Read the lock back", branch: "devloop/pitwall-7b3", issue: "pitwall-7b3" };

test("a reported deploy naming no revision still reads back the one repository that can be read", async () => {
  const { calls, logs, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: [], notes: "both live" },
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    1,
    "one repository configures a verify command and it went unrun because a DIFFERENT repository configures none. " +
      `A host that can be asked must be asked before the step's word is taken for the rest. Steps: ${calls.map((c) => c.label).join(", ")}`,
  );
  assert.equal(
    result.deployed,
    "deployed",
    "the one readable host is serving the sha that merged and the other repository configures nothing that can be " +
      "read, so there is no revision anywhere contradicting the step - and the run held its issues open anyway. " +
      "That is the 2026-08-25 pile-up reached by upgrading.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 1);

  const said = logs.join("\n");
  assert.match(said, /own word/, "the log does not say that the unreadable half rests on the step's assertion");
  assert.match(said, /no verify command/, "the log does not name the configuration that would have checked the rest");
});

test("a reported deploy naming no revision is refused by the host it never mentioned", async () => {
  const { calls, logs, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: [], notes: "both live" },
    check: { status: "read", hosts: hosts(OTHER), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "a step reported deployed and named no host, a readable host came back serving another revision, and the run closed " +
      "on the step's word anyway. Omitting the hosts is the cheaper failure than naming a wrong one and it must not pay better.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed while a host that was read is serving another revision",
  );
  assert.match(logs.join("\n"), new RegExp(OTHER.slice(0, 12)), "the log does not say what the host is serving");
});

test("a reported host with an empty revision is not an answer the step can be credited with", async () => {
  const { calls, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: hosts(""), notes: "the health check timed out right after the deploy" },
    check: { status: "read", hosts: hosts(OTHER), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    1,
    "a host the step reported with no revision in it left the read-back unrun, so nothing asked the host itself",
  );
  assert.notEqual(result.deployed, "deployed", "a host that answered nothing was read as confirming the step");
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
});

test("a deploy step that reports one host twice with two revisions has contradicted itself", async () => {
  const { calls, logs, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: [...hosts(SHA), ...hosts(OTHER)], notes: "both live" },
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "one step reported the same host serving two different revisions and the run still took its word for the " +
      "repository nobody can read. A report that disagrees with itself is not evidence for anything else in it.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
  assert.match(logs.join("\n"), /two different revisions/, "the log does not say the report contradicted itself");
});

test("a host that went quiet on the read-back does not hand the run back to the step's word", async () => {
  const { calls, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: [], notes: "both live" },
    check: { status: "unreadable", hosts: hosts(""), notes: "the health check timed out" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "a repository that configures a verify command was asked, answered nothing, and the run closed on the step's word " +
      "anyway. Only a repository nothing here can ask may rest on the report; one that was asked and did not answer " +
      "is the unknown this comparison exists to hold.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
});

test("a step that names the merge sha for the repository it can read is not said to have named nothing", async () => {
  const { calls, logs, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: hosts(SHA), notes: "both live" },
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.equal(calls.filter((c) => c.label === "deploy-check").length, 1);
  assert.equal(result.deployed, "deployed");
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
  assert.doesNotMatch(
    logs.join("\n"),
    /named no revision/,
    "the step named the sha that merged into the one repository anybody can read, it was compared and it matched, and " +
      "the log says it named nothing. This is the ordinary mixed run - a step doing its job while an unverifiable " +
      "repository drags the status to unknown - so it is the line a supervisor reads most often.",
  );
});

const PARTIAL_VERIFY = {
  ...ARGS,
  repos: {
    docs: {
      ...TWO_ENV.repos.docs,
      verify: { production: "curl -s -m 20 https://example.com/health" },
    },
  },
};

test("a reported revision that disagrees is compared even where a sibling environment cannot be read", async () => {
  const { calls, logs, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: { status: "deployed", hosts: hosts(OTHER, "docs", "production"), notes: "both live" },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "a step reported deployed, named a revision for the one environment anybody can read, that revision is not what " +
      "merged - and the run closed on the step's word because a SIBLING environment of the same repository configures " +
      "no command. An environment nobody can ask never speaks for one somebody can, whether the unaskable one belongs " +
      "to another repository or to this one.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed while the only host anybody can read was reported serving another revision",
  );
  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    1,
    "nothing read the host back. One environment of this repository configures a runnable command, and a reported " +
      "revision that disagrees with what merged is the one case that must reach it.",
  );
  const said = logs.join("\n");
  assert.match(said, new RegExp(`docs production is serving ${OTHER.slice(0, 12)}`), `the log does not say which repository is serving what. Logged:\n${said}`);
  assert.match(said, new RegExp(SHA.slice(0, 12)), "the log does not say what merged, so the two revisions cannot be compared by whoever reads it");
});

test("a reported deploy naming no host still reads back the environment that can be read", async () => {
  const { calls, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: { status: "deployed", hosts: [], notes: "both live" },
    check: { status: "read", hosts: hosts(OTHER, "docs", "production"), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    1,
    "a step that reported deployed and named no host at all was believed for an environment with a runnable command. " +
      "Omitting the hosts is the cheaper failure than naming a wrong one and it must not pay better.",
  );
  assert.notEqual(result.deployed, "deployed", "the host that was read is serving another revision and the run was called deployed");
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
});

test("the environment nobody can ask rests on the step's word once the readable one confirms", async () => {
  const { calls, logs, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: { status: "deployed", hosts: hosts(SHA, "docs", "production"), notes: "both live" },
    check: { status: "read", hosts: hosts(SHA, "docs", "production"), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(
    calls.filter((c) => c.label === "deploy-check").length,
    1,
    "the readable environment was never asked",
  );
  assert.equal(
    result.deployed,
    "deployed",
    "the one environment anybody can read is serving the sha that merged, nothing disagreed, and the staging " +
      "environment configures nothing that could be asked - so the run held its issues open on a configuration gap " +
      "rather than on evidence. That is the 2026-08-25 pile-up reached by upgrading.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
  assert.match(logs.join("\n"), /own word/, "the log does not say that the unreadable environment rests on the step's assertion");
});

test("a step that contradicts itself about an unreadable environment is not believed about the rest", async () => {
  const { calls, logs, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: {
      status: "deployed",
      hosts: [...hosts(SHA, "docs", "production"), ...hosts(SHA, "docs", "staging"), ...hosts(OTHER, "docs", "staging")],
      notes: "both live",
    },
    check: { status: "read", hosts: hosts(SHA, "docs", "production"), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "one report named the staging host twice with two different revisions and the run still took its word for staging, " +
      "because staging is the environment nobody can ask. A report that cannot agree with itself is the weakest evidence " +
      "in the system, not neutral - and an environment nobody can ask is the one place the report is all there is.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0);
  assert.match(logs.join("\n"), /two different revisions/, "the log does not say the report contradicted itself");
});

test("a revision nobody read is not printed as what a host is serving", async () => {
  const { logs, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: { status: "deployed", hosts: hosts(SHA), notes: "both live" },
    check: { status: "read", hosts: hosts(""), notes: "the health check timed out" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.notEqual(result.deployed, "deployed");
  const line = logs.find((l) => l.startsWith("deploy: "));
  assert.ok(line, `no verdict line was logged. Logged:\n${logs.join("\n")}`);
  assert.doesNotMatch(
    line,
    new RegExp(SHA.slice(0, 8)),
    "the verdict line reports a host serving a revision that came from the step's own claim, after the read-back was " +
      `asked and answered nothing. A revision nobody read must never be printed as what a host is serving. Logged: ${line}`,
  );
});

test("an environment nothing can read is named before anything merges", async () => {
  const { calls, logs, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: { status: "deployed", hosts: hosts(SHA, "docs", "production"), notes: "both live" },
    check: { status: "read", hosts: hosts(SHA, "docs", "production"), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  await done;

  const warned = logs.find((l) => l.startsWith("BEFORE ANYTHING MERGES"));
  assert.ok(
    warned,
    "a repository deploys to an environment nothing configured can read back, and the run said so only in the deploy " +
      "summary at the end. A release note is read once by whoever upgrades and the consequence shows up later as " +
      `silence, so the run names the gap before it merges anything. Logged:\n${logs.join("\n")}`,
  );
  assert.match(warned, /docs/);
  assert.match(warned, /one command per environment/);
  const merged = logs.findIndex((l) => /^MERGED|^landed /.test(l));
  assert.ok(
    merged < 0 || logs.indexOf(warned) < merged,
    `the configuration gap was named after something had already merged. Logged:\n${logs.join("\n")}`,
  );
  assert.ok(calls.length > 0);
});

test("a run that takes the step's word is not also told the step was not confirmed", async () => {
  const noVerify = {
    ...ARGS,
    repos: { docs: { path: "site", slug: "owner/site", deploy: TWO_ENV.repos.docs.deploy } },
  };
  const { logs, done } = landOnce({
    args: noVerify,
    deploy: { status: "deployed", hosts: [], notes: "both deployed; nothing here prints a revision" },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(result.deployed, "deployed");
  assert.doesNotMatch(
    logs.join("\n"),
    /do not confirm it/,
    "the run logged that the revisions the step reported do not confirm it and then resolved the same run as deployed. " +
      "Nothing disagreed here - the step named no revision and nothing configured can read one - and a log that says it " +
      "was refuted beside a verdict that closed its issues is the defect this ticket is about, written into the report.",
  );
});

test("a single verify command against two deploy environments reads the one host it can", async () => {
  const oneStringTwoEnvironments = {
    ...ARGS,
    repos: { docs: { ...TWO_ENV.repos.docs, verify: ARGS.repos.docs.verify } },
  };
  const { calls, logs, done } = landOnce({
    args: oneStringTwoEnvironments,
    deploy: null,
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
  });
  const result = await done;

  const check = calls.find((c) => c.label === "deploy-check");
  assert.ok(
    check,
    "a verify written as a single string against a repository that deploys twice names one environment and leaves one " +
      `unaskable, and the one it names went unread. Steps: ${calls.map((c) => c.label).join(", ")}`,
  );
  assert.ok(
    check.prompt.includes("https://staging.example.com/health"),
    "the read-back was spawned without the one command a single-string verify provides",
  );
  assert.equal(
    result.deployed,
    "unknown",
    "one of the two environments configures nothing that can be asked, so the host that answered confirms its own " +
      "environment and not the repository. A single confirmed environment out of two is not a deploy.",
  );
  assert.match(logs.join("\n"), /one command per environment/);
});

const NO_VERIFY_TWO_ENV = {
  ...ARGS,
  repos: { docs: { path: "site", slug: "owner/site", deploy: TWO_ENV.repos.docs.deploy } },
};

test("a reported revision for an environment nothing can read is still compared against what merged", async () => {
  const { calls, logs, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: {
      status: "deployed",
      hosts: [...hosts(SHA, "docs", "production"), ...hosts(OTHER, "docs", "staging")],
      notes: "both live",
    },
    check: { status: "read", hosts: hosts(SHA, "docs", "production"), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the step's own report names the staging host serving a revision that is not what merged, and the run closed on " +
      "that same report because staging is the environment nothing configured can read back. Absence of a command is " +
      "what may rest on the step's word; a revision the step itself handed over is evidence and it disagrees.",
  );
  assert.equal(
    calls.filter((c) => c.label === "close").length,
    0,
    "issues were closed while the report itself said a host is serving another revision",
  );
  const said = logs.join("\n");
  assert.match(said, new RegExp(`docs staging is serving ${OTHER.slice(0, 12)}`), `the log does not say which repository is serving what. Logged:\n${said}`);
  assert.match(said, new RegExp(SHA.slice(0, 12)), "the log does not say what merged, so the two revisions cannot be compared by whoever reads it");
});

test("a report naming wrong revisions for every environment is not believed because none can be read", async () => {
  const { calls, logs, done } = landOnce({
    args: NO_VERIFY_TWO_ENV,
    deploy: {
      status: "deployed",
      hosts: [...hosts(OTHER, "docs", "staging"), ...hosts(OTHER, "docs", "production")],
      notes: "both live",
    },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "a repository configures no verify at all, the step reported deployed, and the revisions it named for both " +
      "environments are not what merged - and the run closed on that report anyway. Nothing here can read a host, so " +
      "the only evidence in the run is the report, and the report disagrees with the run.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0, "issues were closed against the report's own revisions");
  assert.equal(calls.filter((c) => c.label === "deploy-check").length, 0, "a read-back was spawned with no host to read");
  const said = logs.join("\n");
  assert.match(said, new RegExp(`docs staging is serving ${OTHER.slice(0, 12)}`), `the log does not say which repository is serving what. Logged:\n${said}`);
  assert.match(said, new RegExp(SHA.slice(0, 12)), "the log does not say what merged");
});

test("the gap named before anything merges does not promise a close the report can still withdraw", async () => {
  const { calls, logs, done } = landOnce({
    args: NO_VERIFY_TWO_ENV,
    deploy: {
      status: "deployed",
      hosts: [...hosts(SHA, "docs", "staging"), ...hosts(SHA, "docs", "production")],
      notes: "both live",
    },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  await done;

  const warned = logs.find((l) => l.startsWith("BEFORE ANYTHING MERGES"));
  assert.ok(warned, `the configuration gap was not named before anything merged. Logged:\n${logs.join("\n")}`);
  assert.match(
    warned,
    /unless/,
    "this is the one line an upgrading reader sees on the first run, and it says a repository with no verify closes " +
      "on whatever the deploy step says, full stop. It no longer does: a revision the step itself names that is not " +
      `the sha that merged holds the run, with no host read anywhere. Logged: ${warned}`,
  );
  assert.match(
    warned,
    /nothing closes/,
    `the line does not say what happens when the step's own revisions disagree with what merged. Logged: ${warned}`,
  );
  assert.ok(calls.length > 0);
});

test("a wrong revision reported for the repository nobody can read is not covered by a sibling that confirms", async () => {
  const { calls, logs, done } = landOnce({
    args: HALF_CONFIGURED,
    prs: [PR, IN_SITE],
    deploy: {
      status: "deployed",
      hosts: [...hosts(SHA), ...hosts(OTHER, "site", "production")],
      notes: "both live",
    },
    check: { status: "read", hosts: hosts(SHA), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1", "pitwall-7b3"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the repository nobody can read back was reported serving a revision that is not what merged into it, and a " +
      "readable sibling confirming its own host carried the run to deployed. A host that was read speaks for its own " +
      "environment, never for a revision the report disagrees with somewhere else.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0, "issues were closed while the report disagreed about the unreadable repository");
  const said = logs.join("\n");
  assert.match(said, new RegExp(`site production is serving ${OTHER.slice(0, 12)}`), `the log does not say which repository is serving what. Logged:\n${said}`);
  assert.match(said, new RegExp(SHA.slice(0, 12)), "the log does not say what merged");
});

test("a report that contradicts itself holds the run even where every host that was read confirms", async () => {
  const { calls, logs, done } = landOnce({
    args: TWO_ENV,
    deploy: {
      status: "deployed",
      hosts: [
        ...hosts(SHA, "docs", "staging"),
        ...hosts(SHA, "docs", "production"),
        ...hosts(OTHER, "docs", "prod"),
        ...hosts(LATER, "docs", "prod"),
      ],
      notes: "both live",
    },
    check: {
      status: "read",
      hosts: [...hosts(SHA, "docs", "staging"), ...hosts(SHA, "docs", "production")],
      notes: "both hosts answered",
    },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.notEqual(
    result.deployed,
    "deployed",
    "the report named one host twice with two different revisions and the run closed anyway, because the part of the " +
      "report that was checkable happened to agree. A report that cannot agree with itself is the weakest evidence in " +
      "the system and a run may not rest on one, whatever else confirmed.",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 0, "issues were closed on a report that contradicts itself");
  assert.match(
    logs.join("\n"),
    /two different revisions/,
    "the contradiction was found and never printed, so a supervisor reading this run cannot tell it happened",
  );
  assert.doesNotMatch(
    logs.join("\n"),
    /read back instead - deploy is deployed/,
    "the run logged the read-back verdict as deployed and the next line held the same run open. A log line that reports " +
      "a verdict the run did not reach is the same defect as a run that reports what it did not check.",
  );
});

test("the step's word is not described as the only revision when its report named one", async () => {
  const { calls, logs, done } = landOnce({
    args: NO_VERIFY_TWO_ENV,
    deploy: {
      status: "deployed",
      hosts: [...hosts(SHA, "docs", "staging"), ...hosts(SHA, "docs", "production")],
      notes: "both live",
    },
    check: null,
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(
    result.deployed,
    "deployed",
    "nothing configured can read either environment and every revision the report names is the sha that merged, so " +
      "there is nothing disagreeing with the step and the close rests on its word as it always did",
  );
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
  const said = logs.join("\n");
  assert.doesNotMatch(
    said,
    /no revision anybody here could read back/,
    `the report named a revision for both environments and was told it named none. A run that reports what it did not check is this ticket's defect, and a log that reports what was not named is the same defect in the report. Logged:\n${said}`,
  );
  assert.match(said, new RegExp(SHA.slice(0, 12)), "the log does not say which revision the close is resting on");
  assert.match(said, /own word/, "the log does not say the close rests on the step's assertion");
});

test("an unreadable environment whose reported revision agrees is not said to leave nothing to compare", async () => {
  const { calls, logs, done } = landOnce({
    args: PARTIAL_VERIFY,
    deploy: {
      status: "deployed",
      hosts: [...hosts(SHA, "docs", "production"), ...hosts(SHA, "docs", "staging")],
      notes: "both live",
    },
    check: { status: "read", hosts: hosts(SHA, "docs", "production"), notes: "the host answered" },
    close: { status: "closed", closed: ["pitwall-7b1"] },
  });
  const result = await done;

  assert.equal(result.deployed, "deployed", "every revision in the run is the sha that merged and the issues were held open");
  assert.equal(calls.filter((c) => c.label === "close").length, 1);
  const said = logs.join("\n");
  assert.doesNotMatch(
    said,
    /leave no revision to compare/,
    `the report named a revision for staging, it was compared against what merged and it agreed, and the log says staging left no revision to compare. Logged:\n${said}`,
  );
  assert.match(said, /own word/, "the log does not say the unreadable environment rests on the step's assertion");
});
