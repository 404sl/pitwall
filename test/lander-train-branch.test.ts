import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "land-train-1788964650-29574",
  repos: {
    site: { path: "cli", slug: "404sl/pitwall", deploy: ["staging"] },
    docs: { path: "site", slug: "404sl/pitwall-site" },
  },
};

const TOKEN = "land-train-1788964650-29574";
const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";
const BRANCH = "devloop/pitwall-abc";
const OTHER_BRANCH = "devloop/pitwall-def";

type Held = { number?: number; slug?: string; why?: string };
type Result = { landed?: number[]; heldOpen?: Held[] };

const NO_PLUGIN = {
  status: "no_manifest",
  masterVersion: "",
  branchVersion: "",
  touchesPlugin: false,
  notes: "this repository carries no devloop plugin manifest on master",
};

const LEFT_BEHIND = {
  repos: [
    { repo: "site", status: "read", labelled: [] },
    { repo: "docs", status: "read", labelled: [] },
  ],
};

function asked(branches: string[]) {
  return branches.flatMap((branch) => [
    { slug: "404sl/pitwall", branch },
    { slug: "404sl/pitwall-site", branch },
  ]);
}

function train(included: number[], survey: unknown, heldReply: unknown = { status: "noted", noted: [] }) {
  return runScript("land-train.js", { ...ARGS, repo: "site" }, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: TOKEN, holder: TOKEN };
    if (call.label.startsWith("build:")) {
      return { status: "built", trainPr: 120, trainBranch: "release/train-1", included, skipped: [] };
    }
    if (call.label.startsWith("verify:")) return { status: "green", failingSpecs: [] };
    if (call.label.startsWith("version:")) return NO_PLUGIN;
    if (call.label.startsWith("merge:")) return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    if (call.label === "deploy") return { status: "deployed", notes: "", environments: [{ environment: "staging", revision: SHA }] };
    if (call.label === "branch-survey") return survey;
    if (call.label === "held") return heldReply;
    if (call.label === "left-behind") return LEFT_BEHIND;
    return { status: "released" };
  });
}

const CLEAN = {
  status: "read",
  branches: [{ number: 1287, branch: BRANCH }],
  asked: asked([BRANCH]),
  open: [{ slug: "404sl/pitwall-site", number: 44, branch: BRANCH, labelled: true }],
};

function held(out: Result): Held[] {
  return out.heldOpen || [];
}

test("an unlabelled pull request on the same branch in another repository stops the close", async () => {
  const { calls, done } = train([1287], {
    ...CLEAN,
    open: [{ slug: "404sl/pitwall-site", number: 44, branch: BRANCH, labelled: false }],
  });
  const out = (await done) as Result;

  assert.ok(
    !calls.some((c) => c.label === "close"),
    "the ticket was closed while the other half of it was still open and unlabelled. The handoff " +
      "labels every pull request on a branch in one pass; when that pass fails part-way the named " +
      "one is labelled and the sibling is not, so the train merges the labelled half and closes " +
      `the ticket on it. Steps seen: ${calls.map((c) => c.label).join(", ")}.`,
  );
  assert.deepEqual(held(out).map((h) => h.number), [1287], `heldOpen: ${JSON.stringify(out.heldOpen)}`);
  assert.equal(held(out)[0]?.slug, "404sl/pitwall");
  assert.match(
    held(out)[0]?.why || "",
    /404sl\/pitwall-site#44/,
    "the run held the close without naming the pull request that held it, so whoever reads the " +
      "result cannot go and look at it",
  );
  assert.deepEqual(out.landed, [1287], "what actually merged was dropped from the result as well");
});

test("a labelled sibling on the same branch does not stop the close", async () => {
  const { calls, done } = train([1287], CLEAN);
  const out = (await done) as Result;

  const close = calls.find((c) => c.label === "close");
  assert.ok(close, `no close step ran: ${calls.map((c) => c.label).join(", ")}`);
  assert.match(close.prompt, /404sl\/pitwall#1287/);
  assert.deepEqual(held(out), [], "a sibling that carries the label was treated as an orphan, which " +
    "holds every two-repository ticket forever - the gate is about the label, not about a second " +
    "pull request existing");
});

test("only the pull request whose branch is held is kept back", async () => {
  const { calls, done } = train([1287, 1300], {
    status: "read",
    branches: [
      { number: 1287, branch: BRANCH },
      { number: 1300, branch: OTHER_BRANCH },
    ],
    asked: asked([BRANCH, OTHER_BRANCH]),
    open: [{ slug: "404sl/pitwall-site", number: 44, branch: OTHER_BRANCH, labelled: false }],
  });
  const out = (await done) as Result;

  const close = calls.find((c) => c.label === "close");
  assert.ok(close, `no close step ran: ${calls.map((c) => c.label).join(", ")}`);
  assert.match(close.prompt, /404sl\/pitwall#1287/, "a ticket with nothing open on its branch was held " +
    "back because a different ticket in the same train had an orphan");
  assert.doesNotMatch(close.prompt, /404sl\/pitwall#1300/);
  assert.deepEqual(held(out).map((h) => h.number), [1300]);
});

test("a survey that could not be read holds the close rather than passing it", async () => {
  const { calls, done } = train([1287], {
    status: "unreadable",
    branches: [],
    asked: [],
    open: [],
    notes: "gh pr list exited 4: API rate limit exceeded",
  });
  const out = (await done) as Result;

  assert.ok(!calls.some((c) => c.label === "close"), "a failed survey was read as a clean branch");
  assert.match(held(out)[0]?.why || "", /rate limit/);
});

test("a repository the survey never asked about holds the close", async () => {
  const { calls, done } = train([1287], {
    ...CLEAN,
    asked: [{ slug: "404sl/pitwall", branch: BRANCH }],
    open: [],
  });
  const out = (await done) as Result;

  assert.ok(
    !calls.some((c) => c.label === "close"),
    "a repository nobody asked about was read as a repository with nothing on the branch. Both " +
      "print nothing, and that is the whole defect this step exists to catch.",
  );
  assert.match(held(out)[0]?.why || "", /404sl\/pitwall-site/);
});

test("a pull request whose branch the survey never reported holds the close", async () => {
  const { calls, done } = train([1287], { ...CLEAN, branches: [] });
  const out = (await done) as Result;

  assert.ok(!calls.some((c) => c.label === "close"));
  assert.match(held(out)[0]?.why || "", /which branch 404sl\/pitwall#1287 came from/);
});

test("the branch survey is read-only, and asks every configured repository", async () => {
  const { calls, done } = train([1287], CLEAN);
  await done;

  const survey = calls.find((c) => c.label === "branch-survey");
  assert.ok(survey, `no branch survey ran: ${calls.map((c) => c.label).join(", ")}`);
  assert.match(survey.prompt, /site {2}404sl\/pitwall/);
  assert.match(survey.prompt, /docs {2}404sl\/pitwall-site/);
  assert.match(survey.prompt, /--head <branch>/);
  for (const forbidden of [/gh pr merge/, /gh pr close/, /--add-label/, /--remove-label/]) {
    assert.doesNotMatch(
      survey.prompt,
      forbidden,
      `the branch survey is handed a write (${forbidden}). It runs while this train still holds the ` +
        "merge lock and it exists only to report.",
    );
  }
});

test("the branch survey runs after the merge and before the close", async () => {
  const { calls, done } = train([1287], CLEAN);
  await done;

  const order = calls.map((c) => c.label);
  const survey = order.indexOf("branch-survey");
  const merge = order.findIndex((l) => l.startsWith("merge:"));
  const close = order.indexOf("close");
  assert.ok(survey > merge, `the branch was surveyed before the train merged: ${order.join(", ")}`);
  assert.ok(
    close > survey,
    `the close ran before anything had looked at the branch: ${order.join(", ")}. The label alone is ` +
      "what it used to run on, and that is the defect.",
  );
});

test("a held pull request gets one appended note on its ticket naming what held it, and the ticket is neither closed nor reassigned", async () => {
  const { calls, logs, done } = train(
    [1287],
    { ...CLEAN, open: [{ slug: "404sl/pitwall-site", number: 44, branch: BRANCH, labelled: false }] },
    { status: "noted", noted: [{ pr: 1287, issue: "pitwall-abc" }] },
  );
  const out = (await done) as Result;

  assert.deepEqual(held(out).map((h) => h.number), [1287]);
  assert.ok(!calls.some((c) => c.label === "close"));
  const noteSteps = calls.filter((c) => c.label === "held");
  assert.equal(
    noteSteps.length,
    1,
    "the train held 404sl/pitwall#1287 and wrote nothing on its ticket, so it sits in_progress with " +
      "no record of why and reads as a dead lane to whoever finds it. Steps seen: " +
      `${calls.map((c) => c.label).join(", ")}.`,
  );
  const prompt = noteSteps[0]?.prompt || "";
  assert.equal(
    prompt.split("\n").filter((line) => line.includes("bash ") && line.includes("bd-note.sh")).length,
    1,
    "the note step was not told to append through exactly one bd-note.sh command",
  );
  assert.match(prompt, /404sl\/pitwall-site#44/, "the note does not name the pull request that held the close");
  assert.match(prompt, /404sl\/pitwall#1287/, "the note does not say which pull request landed");
  assert.match(prompt, new RegExp(SHA), "the note does not carry the merge sha");
  assert.match(prompt, /--repo 404sl\/pitwall/, "the step resolves the ticket from a pull request number without naming the repository");
  assert.ok(!/bd close/.test(prompt), "the note step was told to close the ticket it is holding");
  assert.ok(!/--notes /.test(prompt), "the note step was pointed at --notes, which replaces every note already on the issue");
  assert.ok(!/--append-notes/.test(prompt), "the note step was told to append by hand rather than through bd-note.sh");
  assert.ok(!/(^|\s)-a |--assignee|--status |--claim/.test(prompt), "the note step was handed a command that moves the ticket");
  assert.match(logs.join("\n"), /noted the hold on 404sl\/pitwall#1287 pitwall-abc/);
});

test("a pull request that closes gets no hold note", async () => {
  const { calls, done } = train([1287], CLEAN);
  await done;

  assert.ok(calls.some((c) => c.label === "close"));
  assert.ok(!calls.some((c) => c.label === "held"), "a note saying the ticket was held was written for a pull request that closed");
});

test("with one pull request held and one clear, the hold note names only the held one", async () => {
  const { calls, done } = train(
    [1287, 1300],
    {
      status: "read",
      branches: [
        { number: 1287, branch: BRANCH },
        { number: 1300, branch: OTHER_BRANCH },
      ],
      asked: asked([BRANCH, OTHER_BRANCH]),
      open: [{ slug: "404sl/pitwall-site", number: 44, branch: OTHER_BRANCH, labelled: false }],
    },
    { status: "noted", noted: [{ pr: 1300, issue: "pitwall-def" }] },
  );
  await done;

  const note = calls.find((c) => c.label === "held");
  assert.ok(note);
  assert.match(note.prompt, /404sl\/pitwall#1300/);
  assert.doesNotMatch(note.prompt, /404sl\/pitwall#1287/, "a pull request that closed was given a note saying it was held");
  const close = calls.find((c) => c.label === "close");
  assert.ok(close);
  assert.doesNotMatch(close.prompt, /404sl\/pitwall#1300/);
});

test("a hold note the step did not confirm is reported", async () => {
  const { logs, done } = train(
    [1287],
    { ...CLEAN, open: [{ slug: "404sl/pitwall-site", number: 44, branch: BRANCH, labelled: false }] },
    null,
  );
  await done;

  assert.match(
    logs.join("\n"),
    /HOLD NOT RECORDED 404sl\/pitwall#1287/,
    "the note step reported nothing and the run said nothing about it, so the ticket is in the " +
      "state this change exists to prevent and nothing reports it",
  );
});
