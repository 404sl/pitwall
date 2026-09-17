import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  repos: {
    site: { path: "cli", slug: "owner/cli" },
    docs: { path: "site", slug: "owner/site" },
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

const BRANCH = "devloop/pitwall-t2v";
const OTHER_BRANCH = "devloop/pitwall-9aa";
const LABELLED = { slug: "owner/cli", number: 31, title: "Read the lanes a board shows", branch: BRANCH, issue: "pitwall-t2v" };
const ORPHAN = { slug: "owner/site", number: 12, title: "Say on the page which lanes a board shows", branch: BRANCH, labelled: false };

function asked(...branches: string[]) {
  return branches.flatMap((branch) => [
    { slug: "owner/cli", branch },
    { slug: "owner/site", branch },
  ]);
}

type Replies = { prs?: unknown[]; branch?: unknown; close?: unknown };
type Held = { issue: string; why: string };
type Result = {
  landed: { slug?: string; number?: number }[];
  heldOpen: Held[];
  unclosed: string[];
  closed: string | null;
};

function landOnce(replies: Replies) {
  const queue = replies.prs || [LABELLED];
  return runScript("land.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: queue } : { prs: [] };
    if (call.label.startsWith("version:")) return NO_PLUGIN;
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    if (call.label === "branch-survey") return replies.branch;
    if (call.label === "close") return replies.close;
    return { status: "released" };
  });
}

function closeCall(calls: Call[]) {
  return calls.find((c) => c.label === "close");
}

test("a ticket whose branch still carries an open unlabelled pull request is not closed", async () => {
  const { calls, logs, done } = landOnce({
    branch: { status: "read", asked: asked(BRANCH), prs: [{ ...LABELLED, labelled: true }, ORPHAN] },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  const result = (await done) as unknown as Result;

  assert.deepEqual(
    result.landed.map((l) => `${l.slug}#${l.number}`),
    ["owner/cli#31"],
    "the labelled half was not merged, so this test is not exercising the window it is about",
  );
  assert.equal(
    closeCall(calls),
    undefined,
    "the ticket was handed to the close step while owner/site#12 sat open and unlabelled on the " +
      "same branch. lane-verified is the only thing the queue above reads, so the orphan is " +
      "invisible to it - and a half-landed ticket that reports success is the failure this " +
      "product exists to surface, produced by the pipeline itself.",
  );
  assert.deepEqual(
    result.heldOpen,
    [
      {
        issue: "pitwall-t2v",
        why:
          "owner/site#12 is open on devloop/pitwall-t2v and does not carry lane-verified, so this " +
          "run's queue never saw it and half of this ticket has not landed",
      },
    ],
    "the run does not say which pull request held the close, so a person has to read two " +
      "repositories to find out what the run already knew",
  );
  assert.match(logs.join("\n"), /NOT CLOSED pitwall-t2v - owner\/site#12/);
});

test("a ticket whose branch carries nothing open, every repository having been asked, is closed as before", async () => {
  const { calls, done } = landOnce({
    branch: { status: "read", asked: asked(BRANCH), prs: [] },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  const result = (await done) as unknown as Result;

  const close = closeCall(calls);
  assert.ok(close, "a ticket with no pull request left on its branch was held anyway");
  assert.ok(close.prompt.includes("pitwall-t2v"), "the close step was not given the issue to close");
  assert.deepEqual(result.heldOpen, []);
  assert.deepEqual(result.unclosed, []);
  assert.equal(result.closed, "closed");
});

test("an open pull request that does carry the label holds nothing", async () => {
  const { calls, done } = landOnce({
    branch: { status: "read", asked: asked(BRANCH), prs: [{ ...ORPHAN, labelled: true }] },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  const result = (await done) as unknown as Result;

  assert.ok(
    closeCall(calls),
    "a labelled pull request held the close. A labelled one is in the queue above - landed in " +
      "this run or reported in skipped - so gating on it would hold every ticket whose second " +
      "half simply has not reached the front yet.",
  );
  assert.deepEqual(result.heldOpen, []);
});

test("a branch survey that could not read a repository holds the close rather than guessing", async () => {
  const { calls, logs, done } = landOnce({
    branch: { status: "unreadable", asked: asked(BRANCH), prs: [], notes: "gh said HTTP 403 for owner/site" },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  const result = (await done) as unknown as Result;

  assert.equal(
    closeCall(calls),
    undefined,
    "a survey that reported it could not read a repository was treated as a survey that found " +
      "nothing. A failed list and a branch with no second half both come back empty, so reading " +
      "the empty one as a pass reintroduces the defect on every rate limit and expired token.",
  );
  assert.deepEqual(
    result.heldOpen.map((h) => h.issue),
    ["pitwall-t2v"],
  );
  assert.match(logs.join("\n"), /gh said HTTP 403 for owner\/site/);
});

test("a branch survey step that reported nothing at all holds the close too", async () => {
  const { calls, done } = landOnce({ branch: null, close: { status: "closed", closed: ["pitwall-t2v"] } });
  const result = (await done) as unknown as Result;

  assert.equal(closeCall(calls), undefined, "a killed survey step closed the ticket");
  assert.deepEqual(
    result.heldOpen.map((h) => h.issue),
    ["pitwall-t2v"],
  );
});

test("one ticket held does not hold another whose branch is clear", async () => {
  const second = { slug: "owner/cli", number: 32, title: "Name the build a board was cut from", branch: OTHER_BRANCH, issue: "pitwall-9aa" };
  const { calls, done } = landOnce({
    prs: [LABELLED, second],
    branch: { status: "read", asked: asked(BRANCH, OTHER_BRANCH), prs: [{ ...LABELLED, labelled: true }, ORPHAN] },
    close: { status: "closed", closed: ["pitwall-9aa"] },
  });
  const result = (await done) as unknown as Result;

  const close = closeCall(calls);
  assert.ok(close, "nothing was closed at all");
  assert.ok(close.prompt.includes("pitwall-9aa"), "a ticket whose branch is clear was held with the other one");
  assert.ok(
    !close.prompt.includes("pitwall-t2v"),
    "the held ticket was handed to the close step alongside the clear one",
  );
  assert.deepEqual(
    result.heldOpen.map((h) => h.issue),
    ["pitwall-t2v"],
  );
  assert.deepEqual(result.unclosed, []);
});

test("the survey is asked about every configured repository, not only the ones that landed", async () => {
  const { calls, done } = landOnce({
    branch: { status: "read", asked: asked(BRANCH), prs: [] },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  await done;

  const survey = calls.find((c) => c.label === "branch-survey");
  assert.ok(survey, "the branch was never surveyed");
  assert.ok(survey.prompt.includes("owner/cli"), "the repository that landed was not asked");
  assert.ok(
    survey.prompt.includes("owner/site"),
    "a configured repository was left out of the survey, which is exactly where the orphan sits - " +
      "it is in the repository the run did NOT land anything in",
  );
  assert.ok(survey.prompt.includes(BRANCH), "the survey was not told which branch to look for");
  assert.ok(
    survey.prompt.includes("--head"),
    "the survey was not told to list by head branch, which is the only thing tying a pull " +
      "request to a ticket across two repositories",
  );
});

test("a survey that never says it asked a repository holds the close, the same as one that could not read it", async () => {
  const { calls, logs, done } = landOnce({
    branch: { status: "read", asked: [{ slug: "owner/cli", branch: BRANCH }], prs: [] },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  const result = (await done) as unknown as Result;

  assert.equal(
    closeCall(calls),
    undefined,
    "a survey that reported no answer at all for owner/site was read as a survey that found " +
      "nothing there. An unasked repository and a clean one both report nothing, so a step that " +
      "stopped early - or never ran the command for the repository the orphan sits in - closes " +
      "the ticket exactly as the unsurveyed lander did. The gate has to be a list of what was " +
      "asked, not a list of what was found.",
  );
  assert.deepEqual(
    result.heldOpen.map((h) => h.issue),
    ["pitwall-t2v"],
  );
  assert.match(
    result.heldOpen.map((h) => h.why).join("\n"),
    /owner\/site/,
    "the run does not name the repository that went unreported, so a person cannot tell which " +
      "command to run by hand",
  );
  assert.match(logs.join("\n"), /NOT CLOSED pitwall-t2v - the survey did not report asking owner\/site/);
});

test("a repository asked about one branch is not credited with the other", async () => {
  const second = { slug: "owner/cli", number: 32, title: "Name the build a board was cut from", branch: OTHER_BRANCH, issue: "pitwall-9aa" };
  const { calls, done } = landOnce({
    prs: [LABELLED, second],
    branch: { status: "read", asked: asked(BRANCH), prs: [] },
    close: { status: "closed", closed: ["pitwall-t2v"] },
  });
  const result = (await done) as unknown as Result;

  const close = closeCall(calls);
  assert.ok(close, "nothing was closed at all");
  assert.ok(
    close.prompt.includes("pitwall-t2v"),
    "the ticket whose branch every repository reported asking about was held anyway",
  );
  assert.ok(
    !close.prompt.includes("pitwall-9aa"),
    "a branch no repository reported asking about was closed. Pairs are per repository AND per " +
      "branch: a step that surveyed the first branch and stopped reports the same empty prs as a " +
      "step that surveyed both.",
  );
  assert.deepEqual(
    result.heldOpen.map((h) => h.issue),
    ["pitwall-9aa"],
  );
});
