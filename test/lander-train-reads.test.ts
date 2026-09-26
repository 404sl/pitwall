import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "land-train-1788964650-29574",
  repos: {
    site: { path: "cli", slug: "404sl/pitwall" },
    docs: { path: "site", slug: "404sl/pitwall-site" },
  },
};

const TOKEN = "land-train-1788964650-29574";
const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";
const INCLUDED = [1287, 1288];

function branchSurvey() {
  const branches = INCLUDED.map((n) => ({ number: n, branch: `devloop/pitwall-${n}` }));
  return {
    status: "read",
    branches,
    asked: branches.flatMap(({ branch }) => [
      { slug: "404sl/pitwall", branch },
      { slug: "404sl/pitwall-site", branch },
    ]),
    open: [{ slug: "404sl/pitwall-site", number: 61, branch: "devloop/pitwall-1288", labelled: false }],
  };
}

function train() {
  return runScript("land-train.js", { ...ARGS, repo: "site" }, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", holder: TOKEN };
    if (call.label.startsWith("build:")) {
      return { status: "built", trainPr: 120, trainBranch: "release/train-1", included: INCLUDED, skipped: [] };
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
    if (call.label === "branch-survey") return branchSurvey();
    if (call.label === "held") return { status: "noted", noted: [{ pr: 1288, issue: "pitwall-1288" }], notes: "" };
    if (call.label === "close") return { status: "closed", closed: [{ pr: 1287, issue: "pitwall-1287" }], notes: "" };
    if (call.label === "left-behind") {
      return { repos: [{ repo: "site", status: "read", labelled: [] }, { repo: "docs", status: "read", labelled: [] }] };
    }
    return { status: "released" };
  });
}

function step(calls: Call[], label: string): Call {
  const found = calls.find((c) => c.label === label || c.label.startsWith(`${label}:`));
  assert.ok(found, `no ${label} step ran: ${calls.map((c) => c.label).join(", ")}`);
  return found;
}

const EVIDENCE = "gh pr view 120 --repo 404sl/pitwall --json labels,statusCheckRollup";
const COMMAND = /^\s+(cd \S+ && )?gh pr (list|view) /m;

test("the left-behind survey lists labelled pull requests over REST, filtered on the label", async () => {
  const { calls, done } = train();
  await done;

  const survey = step(calls, "left-behind");
  assert.match(
    survey.prompt,
    /gh api "repos\/<that repository's owner\/name>\/pulls\?state=open&per_page=100" --jq 'map\(if any\(\.labels\[\]; \.name == "lane-verified"\) then \.number else empty end\)'/,
    "the survey lists pull requests with a GraphQL command - gh pr list is refused with 'API rate " +
      "limit already exceeded' while REST answers, and a refused list here is reported as an empty queue",
  );
  assert.doesNotMatch(survey.prompt, COMMAND, "the survey still runs gh pr list");
  assert.equal(survey.prompt.includes("|"), false, "a pipe inside --jq is broken by the shell the step runs in");
});

test("the train's checks are read from the head sha's check runs, never from the status endpoint", async () => {
  const { calls, done } = train();
  await done;

  const verify = step(calls, "verify");
  assert.match(
    verify.prompt,
    /gh api repos\/404sl\/pitwall\/pulls\/120 --jq '\{headSha: \.head\.sha, state, merged\}'/,
    "the head sha is not read over REST",
  );
  assert.match(
    verify.prompt,
    /gh api repos\/404sl\/pitwall\/commits\/<that headSha>\/check-runs --jq '\{total_count, names: \[\.check_runs\[\]\.name\], statuses: \[\.check_runs\[\]\.status\], conclusions: \[\.check_runs\[\]\.conclusion\]\}'/,
    "the checks are read with a GraphQL command - the rollup over REST is the commit's check runs",
  );
  assert.doesNotMatch(
    verify.prompt,
    /^\s+(cd \S+ && )?gh api [^\n]*\/commits\/[^\n]*\/status\b/m,
    "the prompt offers the combined-status endpoint, which reports pending forever on these repositories",
  );
  assert.match(verify.prompt, /NEVER READ repos\/404sl\/pitwall\/commits\/<sha>\/status/);
  assert.match(verify.prompt, /AN EMPTY check_runs ARRAY IS NOT A PASS/, "an empty check_runs array reads as a pass");
  assert.match(verify.prompt, /every conclusion "success"/, "REST spells conclusion in lower case and the prompt compares against SUCCESS");
  assert.doesNotMatch(verify.prompt, COMMAND, "the verify step still runs gh pr view");
});

test("the close step reads state and merged over REST and says how REST spells a retired pull request", async () => {
  const { calls, done } = train();
  await done;

  const merge = step(calls, "merge");
  assert.match(merge.prompt, /gh api repos\/404sl\/pitwall\/pulls\/<n> --jq '\{state, merged\}'    for each of 1287, 1288/);
  assert.match(merge.prompt, /state "closed"/, "the prompt does not say REST spells state in lower case");
  assert.match(merge.prompt, /merged true/, "the prompt does not say a merged pull request is closed with merged true");
  assert.ok(merge.prompt.includes(EVIDENCE), "the evidence line the merge permission is scoped to was changed");
  const rest = merge.prompt.replace(EVIDENCE, "");
  assert.doesNotMatch(rest, COMMAND, "the merge step runs gh pr view for something other than the evidence line");
});

test("the branch and body reads project the fields the steps are told to copy", async () => {
  const { calls, done } = train();
  await done;

  const branches = step(calls, "branch-survey");
  assert.match(branches.prompt, /gh api repos\/404sl\/pitwall\/pulls\/<n> --jq '\{number, headRefName: \.head\.ref\}'/);
  assert.match(
    branches.prompt,
    /gh api "repos\/<that repository's owner\/name>\/pulls\?state=open&per_page=100" --jq 'map\(if \.head\.ref == "<branch>" then \{number, headRefName: \.head\.ref, title, labels: \[\.labels\[\]\.name\]\} else empty end\)'/,
    "the sibling search lists with a GraphQL command, and a refused list reads as a repository with nothing on the branch",
  );
  for (const label of ["close", "held"]) {
    const prompt = step(calls, label).prompt;
    assert.match(
      prompt,
      /gh api repos\/404sl\/pitwall\/pulls\/<n> --jq '\{headRefName: \.head\.ref, body, title\}'/,
      `the ${label} step reads the pull request body with a GraphQL command`,
    );
  }
});

test("no prompt names gh pr list or gh pr view as a command to run, except the merge evidence line", async () => {
  const { calls, done } = train();
  await done;

  for (const call of calls) {
    const prompt = call.prompt.replace(EVIDENCE, "");
    assert.doesNotMatch(prompt, COMMAND, `${call.label} still runs a GraphQL read`);
    assert.equal(prompt.includes("`"), false, `a backtick in the ${call.label} brief closes its template literal early`);
  }
});
