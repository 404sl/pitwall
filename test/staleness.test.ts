import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, hasLiveStructuralBlocker } from "../src/classify.ts";
import type { ClassifyContext, UnclassifiedIssue } from "../src/classify.ts";
import { preconditionProbe } from "../src/probes.ts";
import { assess, isAssessable, noteBlocks, unresolvedCount } from "../src/staleness.ts";
import type { ParkedRecord, PullState, StalenessContext } from "../src/staleness.ts";

const CHECKED_AT = new Date("2026-09-08T09:00:00Z");

function aRecord(over: Partial<ParkedRecord> = {}): ParkedRecord {
  return {
    id: "mw-1",
    title: "mw-1",
    classification: "blocked",
    labels: [],
    blockedBy: [],
    structurallyBlocked: false,
    ...over,
  };
}

function anIssue(id: string, over: Partial<UnclassifiedIssue> = {}): UnclassifiedIssue {
  return { id, title: id, status: "open", labels: [], blockedBy: [], ...over };
}

function asRecorded(
  id: string,
  issues: readonly UnclassifiedIssue[],
  text: Partial<ParkedRecord> = {},
): ParkedRecord {
  const issue = issues.find((other) => other.id === id);
  assert.ok(issue !== undefined, `${id} is not in the fixture`);
  const context: ClassifyContext = { issues, lanes: [], collectionComplete: true };
  const { classification } = classify(issue, context);
  assert.ok(classification !== undefined, `${id} is closed, so nothing classifies it`);
  return {
    id: issue.id,
    title: issue.title,
    classification,
    labels: issue.labels,
    blockedBy: issue.blockedBy,
    structurallyBlocked: hasLiveStructuralBlocker(issue, context),
    ...text,
  };
}

function trackerOf(issues: readonly UnclassifiedIssue[]): Partial<StalenessContext> {
  return {
    knownIds: new Set(issues.map((issue) => issue.id)),
    closedIds: new Set(
      issues.flatMap((issue) => (issue.status === "closed" ? [issue.id] : [])),
    ),
  };
}

function aContext(over: Partial<StalenessContext> = {}): StalenessContext {
  return { now: CHECKED_AT, ...over };
}

function tracker(ids: Record<string, "open" | "closed">): Partial<StalenessContext> {
  return {
    knownIds: new Set(Object.keys(ids)),
    closedIds: new Set(Object.entries(ids).flatMap(([id, state]) => (state === "closed" ? [id] : []))),
  };
}

function pulls(states: Record<string, PullState>, issueId?: string): Partial<StalenessContext> {
  return {
    pullFacts: async (reference) => {
      const state = states[reference.text];
      return state === undefined ? undefined : { state, issueId };
    },
  };
}

function answers(passed: boolean | undefined): {
  probe: StalenessContext["probe"];
  asked: string[][];
} {
  const asked: string[][] = [];
  return {
    asked,
    probe: async (command) => {
      asked.push([...command]);
      return passed;
    },
  };
}

function matches(evidence: readonly string[], pattern: RegExp): boolean {
  return evidence.some((line) => pattern.test(line));
}

test("a stamped note is quoted by what it says, not by its stamp", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      labelledAt: "2026-09-01T10:00:00Z",
      notedAt: "2026-09-05T14:00:00Z",
      notes:
        "2026-09-05T14:00:00Z lane-mw-1\nThe owner granted the token and the upload went through.",
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(matches(staleness.evidence, /"The owner granted the token/));
});

test("a note written after the parking label reads as an answer", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      labelledAt: "2026-09-01T10:00:00Z",
      notedAt: "2026-09-05T14:00:00Z",
      notes: "The owner granted the token and the upload went through.",
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(matches(staleness.evidence, /after the needs-access label went on/));
  assert.equal(staleness.checkedAt, CHECKED_AT.toISOString());
});

test("a note written before the parking label leaves the blocker standing", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      labelledAt: "2026-09-05T14:00:00Z",
      notedAt: "2026-09-01T10:00:00Z",
      notes: "Asked the owner for the token.",
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.ok(matches(staleness.evidence, /nothing has been recorded since the needs-access label/));
});

test("a later note that defers rather than answers is not an answer", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:decision",
      labels: ["needs-decision"],
      labelledAt: "2026-09-01T10:00:00Z",
      notedAt: "2026-09-05T14:00:00Z",
      notes: "Define it, then build, but not yet.",
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.ok(matches(staleness.evidence, /defers rather than answers/));
});

const LAYERED_NOTES = [
  "Parked behind the migration, not yet.",
  "Chased the owner again.",
  "Answered: go ahead with the smaller shape.",
].join("\n\n");

test("a note is one blank-line-separated block, and the count a reader sees is the block the check reads", async () => {
  assert.deepEqual(noteBlocks(LAYERED_NOTES), [
    "Parked behind the migration, not yet.",
    "Chased the owner again.",
    "Answered: go ahead with the smaller shape.",
  ]);
  assert.deepEqual(noteBlocks(""), []);
  assert.deepEqual(noteBlocks("  \n \n  "), []);
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      labelledAt: "2026-09-01T10:00:00Z",
      notedAt: "2026-09-05T14:00:00Z",
      notes: LAYERED_NOTES,
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(matches(staleness.evidence, /Answered: go ahead with the smaller shape\./));
  assert.ok(
    !matches(staleness.evidence, /defers rather than answers/),
    "an earlier block that defers is history, not the standing note",
  );
});

test("a tracker that does not record when a label went on leaves the check unrun and states nothing", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      notes: "The owner granted the token.",
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, [], "a limitation of the method is not a finding about the issue");
});

test("an issue whose every named issue has closed is no longer waiting on the ordering", async () => {
  const { staleness } = await assess(
    aRecord({ labels: ["blocked-tooling"], classification: "parked:tooling", notes: "Blocked until mw-9 lands." }),
    aContext({ idPrefix: "mw", ...tracker({ "mw-9": "closed" }) }),
  );
  assert.equal(staleness.verdict, "resolved");
  assert.ok(matches(staleness.evidence, /every issue it names has since closed: mw-9/));
});

test("an issue naming an issue that is still open keeps its blocker", async () => {
  const { staleness } = await assess(
    aRecord({ labels: ["blocked-tooling"], classification: "parked:tooling", notes: "Blocked until mw-9 lands." }),
    aContext({ idPrefix: "mw", ...tracker({ "mw-9": "open" }) }),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.ok(matches(staleness.evidence, /it names mw-9, still open/));
});

test("a name the tracker has never heard of is not read as a closed issue", async () => {
  const { staleness } = await assess(
    aRecord({ classification: "parked:watch", notes: "Raised by mw-devloop in passing." }),
    aContext({ idPrefix: "mw", ...tracker({}) }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, []);
});

test("an id inside a note's stamp is not an issue the note names", async () => {
  const chasing = (): Partial<ParkedRecord> => ({
    id: "pitwall-100",
    title: "pitwall-100",
    classification: "parked:watch",
    labels: ["parked:watch"],
    labelledAt: "2026-09-05T10:00:00Z",
    notedAt: "2026-09-02T10:00:00Z",
    notes:
      "2026-09-09T08:00:00Z lane-devloop/pitwall-777\nChased the vendor again, still nothing back.",
  });
  const closed = await assess(
    aRecord(chasing()),
    aContext({ idPrefix: "pitwall", ...tracker({ "pitwall-777": "closed" }) }),
  );
  assert.equal(closed.staleness.verdict, "still-blocking");
  assert.ok(
    !matches(closed.staleness.evidence, /every issue it names/),
    "the lane that wrote the note is not an issue the note is waiting on",
  );
  const open = await assess(
    aRecord(chasing()),
    aContext({ idPrefix: "pitwall", ...tracker({ "pitwall-777": "open" }) }),
  );
  assert.ok(
    !matches(open.staleness.evidence, /it names pitwall-777/),
    "an issue nothing checked is not reported as checked",
  );
});

test("a log line that opens with an instant still names the issue it is waiting on", async () => {
  const log = "2026-09-09T08:14:02Z gate refused: waiting on pitwall-333 to land the contract field";
  const above = [
    "2026-09-09T08:00:00Z lane-devloop/pitwall-326",
    "Rolled back. The duplicate pitwall-222 was closed first, which is why this one stayed.",
    "Run log pasted below:",
  ];
  const below = ["so nothing here can proceed until that one is in."];
  const shapes: Record<string, string> = {
    "inside a block": [...above, log, ...below].join("\n"),
    "opening a block of its own": [...above, "", log, ...below].join("\n"),
  };
  for (const [shape, notes] of Object.entries(shapes)) {
    const { staleness } = await assess(
      aRecord({
        id: "pitwall-100",
        title: "pitwall-100",
        classification: "parked:watch",
        labels: ["parked:watch"],
        notes,
      }),
      aContext({
        idPrefix: "pitwall",
        ...tracker({ "pitwall-222": "closed", "pitwall-333": "open" }),
      }),
    );
    assert.equal(staleness.verdict, "still-blocking", `a log line ${shape} was read as a stamp`);
    assert.ok(
      matches(staleness.evidence, /it names pitwall-333, still open/),
      `the open issue named by a log line ${shape} was dropped with the line naming it`,
    );
    assert.ok(
      !matches(staleness.evidence, /every issue it names/),
      `a record waiting on an open issue was reported as resolved from a log line ${shape}`,
    );
  }
});

test("a referenced pull request that has merged is reported as merged", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:decision",
      labels: ["needs-decision"],
      notes: "Parked behind https://github.com/404sl/pitwall/pull/12.",
    }),
    aContext(pulls({ "https://github.com/404sl/pitwall/pull/12": "merged" })),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(matches(staleness.evidence, /has merged: https:\/\/github\.com\/404sl\/pitwall\/pull\/12/));
});

test("a referenced pull request that is still open leaves the blocker standing", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:decision",
      labels: ["needs-decision"],
      notes: "Parked behind https://github.com/404sl/pitwall/pull/12.",
    }),
    aContext(pulls({ "https://github.com/404sl/pitwall/pull/12": "open" })),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.ok(matches(staleness.evidence, /is open, not merged/));
});

test("a recorded reason whose command now succeeds is likely stale", async () => {
  const { probe, asked } = answers(true);
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      description: "npm whoami is a 401 on this machine, so nothing can be published.",
    }),
    aContext({ probe }),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(matches(staleness.evidence, /`npm whoami`, which now succeeds/));
  assert.deepEqual(asked, [["npm", "whoami"]]);
});

test("a recorded reason whose command still fails is still blocking", async () => {
  const { probe } = answers(false);
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      description: "npm whoami is a 401 on this machine, so nothing can be published.",
    }),
    aContext({ probe }),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.ok(matches(staleness.evidence, /`npm whoami`, which still fails/));
});

test("only the commands on the allow-list are ever run", async () => {
  const { probe, asked } = answers(true);
  const { staleness } = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      title: "Waiting on rm -rf /tmp/store",
      description: "Run `curl https://example.test/grant` and `psql -c 'drop table sessions'` first.",
    }),
    aContext({ probe }),
  );
  assert.deepEqual(asked, []);
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, []);
});

test("the probe refuses a command that is not on the allow-list without spawning it", async () => {
  const probe = preconditionProbe();
  assert.equal(await probe(["rm", "-rf", "/"]), undefined);
  assert.equal(await probe(["npm", "publish"]), undefined);
});

test("a needs-decision issue is never reported resolved, however many checks fire", async () => {
  const { probe } = answers(true);
  const { staleness } = await assess(
    aRecord({
      classification: "yours:decision",
      labels: ["needs-decision"],
      labelledAt: "2026-09-01T10:00:00Z",
      notedAt: "2026-09-05T14:00:00Z",
      notes: "Answered: go ahead. Superseded mw-9. npm whoami is a 401 on this machine.",
      description: "Parked behind https://github.com/404sl/pitwall/pull/12.",
    }),
    aContext({
      idPrefix: "mw",
      ...tracker({ "mw-9": "closed" }),
      ...pulls({ "https://github.com/404sl/pitwall/pull/12": "merged" }),
      probe,
    }),
  );
  assert.equal(staleness.verdict, "likely-stale");
});

test("an issue nobody has been able to check reports unchecked and claims no finding", async () => {
  const { staleness, errors } = await assess(
    aRecord({ classification: "parked:roadmap" }),
    aContext({ idPrefix: "mw", probe: async () => true, pullFacts: async () => undefined }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.equal(staleness.checkedAt, undefined);
  assert.deepEqual(staleness.evidence, []);
  assert.deepEqual(errors, [], "nothing was checked, and nothing failed to be checked either");
});

test("every verdict that ran a check carries evidence a person can check by hand", async () => {
  const { probe } = answers(true);
  const records: ParkedRecord[] = [
    aRecord({ classification: "parked:roadmap" }),
    aRecord({ classification: "parked:tooling", notes: "Blocked until mw-9 lands." }),
    aRecord({ classification: "yours:access", description: "npm whoami is a 401 here." }),
    aRecord({ classification: "blocked", notes: "Blocked until mw-8 lands.", blockedBy: ["mw-8"] }),
  ];
  const verdicts = new Set<string>();
  for (const record of records) {
    const { staleness } = await assess(
      record,
      aContext({ idPrefix: "mw", ...tracker({ "mw-9": "closed", "mw-8": "open" }), probe }),
    );
    verdicts.add(staleness.verdict);
    if (staleness.verdict === "unchecked") {
      assert.deepEqual(staleness.evidence, [], `${record.classification} stated a finding without checking`);
    } else {
      assert.ok(staleness.evidence.length > 0, `${record.classification} carried no evidence`);
    }
  }
  assert.deepEqual([...verdicts].sort(), ["likely-stale", "resolved", "still-blocking", "unchecked"].sort());
});

test("only an issue that stopped for a reason is worth checking", () => {
  assert.equal(isAssessable("ready"), false);
  assert.equal(isAssessable("in-flight"), false);
  assert.equal(isAssessable("landing"), true);
  assert.equal(isAssessable("blocked"), true);
  assert.equal(isAssessable("parked:watch"), true);
  assert.equal(isAssessable("yours:access"), true);
});

test("an issue left in progress after its pull request merged is reported likely stale", async () => {
  const { staleness, errors } = await assess(
    aRecord({ id: "mw-7b1", classification: "landing", notes: "Landed as site#16." }),
    aContext({ idPrefix: "mw", ...pulls({ "site#16": "merged" }, "mw-7b1") }),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.equal(staleness.checkedAt, CHECKED_AT.toISOString());
  assert.ok(matches(staleness.evidence, /site#16/), "the merged pull request is not in the evidence");
  assert.deepEqual(errors, []);
});

test("an issue in progress whose pull request is still open is still blocking", async () => {
  const { staleness } = await assess(
    aRecord({ id: "mw-7b1", classification: "landing", notes: "Landing as site#16." }),
    aContext({ idPrefix: "mw", ...pulls({ "site#16": "open" }, "mw-7b1") }),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.deepEqual(staleness.evidence, ["site#16 is open, not merged"]);
});

test("an issue somebody has only just picked up states no finding", async () => {
  const { staleness, errors } = await assess(
    aRecord({ classification: "landing", notes: "Claimed, nothing pushed yet." }),
    aContext({ idPrefix: "mw", probe: async () => true, pullFacts: async () => undefined }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, [], "no lane working it is suspicious, never conclusive");
  assert.deepEqual(errors, []);
});

test("nothing but a merged pull request concludes on an issue in progress", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "landing",
      description: "Follows the pattern set in mw-9, once npm whoami works.",
    }),
    aContext({ idPrefix: "mw", ...tracker({ "mw-9": "closed" }), probe: async () => true }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, []);
});

test("a merged pull request another issue owns is not this issue landing", async () => {
  const { staleness, errors } = await assess(
    aRecord({
      id: "mw-0ai",
      classification: "landing",
      description: "Follow the shape of the repo field added in site#16. Nothing pushed yet.",
    }),
    aContext({ idPrefix: "mw", ...pulls({ "site#16": "merged" }, "mw-7b1") }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, [], "a reference it merely cites was read as its own landing");
  assert.deepEqual(errors, []);
});

test("a merged pull request that names no issue is not this issue landing", async () => {
  const { staleness } = await assess(
    aRecord({ id: "mw-0ai", classification: "landing", description: "See site#16." }),
    aContext({ idPrefix: "mw", ...pulls({ "site#16": "merged" }) }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, []);
});

test("only the pull request an issue owns concludes that it landed", async () => {
  const owners: Record<string, string> = { "site#16": "mw-7b1", "site#41": "mw-0ai" };
  const { staleness } = await assess(
    aRecord({
      id: "mw-0ai",
      classification: "landing",
      description: "Follows site#16.",
      notes: "Landed as site#41.",
    }),
    aContext({
      idPrefix: "mw",
      pullFacts: async (reference) => ({
        state: "merged" as PullState,
        issueId: owners[reference.text],
      }),
    }),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.deepEqual(staleness.evidence, ["the pull request it waits on has merged: site#41"]);
});

test("a pull request that could not be looked up never reads as no merge", async () => {
  const { staleness, errors } = await assess(
    aRecord({ id: "mw-7b1", classification: "landing", notes: "Landed as site#16." }),
    aContext({ idPrefix: "mw", pullFacts: async () => undefined }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.ok(!matches(staleness.evidence, /not merged/));
  assert.deepEqual(errors, [
    {
      source: "staleness mw-7b1",
      message: "1 reference could not be checked: site#16",
      at: CHECKED_AT.toISOString(),
    },
  ]);
});

const ANSWERED = "Follows the pattern set in mw-9.";

test("a child of an issue somebody is working is never reported resolved", async () => {
  const issues = [
    anIssue("mw-9", { status: "closed" }),
    anIssue("mw-30", { status: "in_progress" }),
    anIssue("mw-30.1"),
  ];
  const record = asRecorded("mw-30.1", issues, { notes: ANSWERED });
  assert.equal(record.classification, "blocked");
  assert.equal(record.structurallyBlocked, true);
  const { staleness } = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(!matches(staleness.evidence, /no open dependency of its own remains/));
});

test("an issue with an open child is never reported resolved", async () => {
  const issues = [anIssue("mw-9", { status: "closed" }), anIssue("mw-30"), anIssue("mw-30.1")];
  const record = asRecorded("mw-30", issues, { notes: ANSWERED });
  assert.equal(record.classification, "parked:umbrella");
  assert.equal(record.structurallyBlocked, true);
  const { staleness } = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(!matches(staleness.evidence, /no open dependency of its own remains/));
});

test("a watch label does not hide an open child from the check", async () => {
  const issues = [
    anIssue("mw-9", { status: "closed" }),
    anIssue("mw-30", { labels: ["watch"] }),
    anIssue("mw-30.1"),
  ];
  const record = asRecorded("mw-30", issues, { notes: ANSWERED });
  assert.equal(record.classification, "parked:watch");
  assert.equal(record.structurallyBlocked, true);
  const { staleness } = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(!matches(staleness.evidence, /no open dependency of its own remains/));
});

test("a roadmap label does not hide a parent somebody is working from the check", async () => {
  const issues = [
    anIssue("mw-9", { status: "closed" }),
    anIssue("mw-30", { status: "in_progress" }),
    anIssue("mw-30.1", { labels: ["roadmap"] }),
  ];
  const record = asRecorded("mw-30.1", issues, { notes: ANSWERED });
  assert.equal(record.classification, "parked:roadmap");
  assert.equal(record.structurallyBlocked, true);
  const { staleness } = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(!matches(staleness.evidence, /no open dependency of its own remains/));
});

test("a parked issue with nothing of its own left open is still reported resolved", async () => {
  const issues = [anIssue("mw-9", { status: "closed" }), anIssue("mw-30", { labels: ["blocked-tooling"] })];
  const record = asRecorded("mw-30", issues, { notes: ANSWERED });
  assert.equal(record.classification, "parked:tooling");
  assert.equal(record.structurallyBlocked, false);
  const { staleness } = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "resolved");
  assert.ok(matches(staleness.evidence, /no open dependency of its own remains/));
});

test("a markdown anchor is not read as a pull request reference", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "parked:tooling",
      description: "See [the naming section](#3) of docs/style.md before starting.",
    }),
    aContext(pulls({ "#3": "merged" })),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, [], "an anchor that is not a reference is not a finding either");
});

test("a bare pull number in a merge title is still read as a pull request reference", async () => {
  const { staleness } = await assess(
    aRecord({
      classification: "yours:decision",
      labels: ["needs-decision"],
      notes: 'Waiting on "The console - urgency-first screen over every project (#12)".',
    }),
    aContext(pulls({ "#12": "merged" })),
  );
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(matches(staleness.evidence, /has merged: #12/));
});

test("a reference that could not be looked up is a collection failure, not a finding", async () => {
  const { staleness, errors } = await assess(
    aRecord({
      id: "mw-4",
      classification: "yours:decision",
      labels: ["needs-decision"],
      notes: "Waiting on ext#144, ext#148 and ext#150.",
    }),
    aContext({ idPrefix: "mw", probe: async () => true, pullFacts: async () => undefined }),
  );
  assert.ok(!matches(staleness.evidence, /could not resolve/));
  assert.deepEqual(errors, [
    {
      source: "staleness mw-4",
      message: "3 references could not be checked: ext#144, ext#148, ext#150",
      at: CHECKED_AT.toISOString(),
    },
  ]);
});

test("a reference that resolved is still evidence beside the ones that did not", async () => {
  const { staleness, errors } = await assess(
    aRecord({
      id: "mw-4",
      classification: "yours:decision",
      labels: ["needs-decision"],
      notes: "Waiting on site#1128 and ext#150.",
    }),
    aContext({
      idPrefix: "mw",
      probe: async () => true,
      pullFacts: async (reference) =>
        reference.text === "site#1128" ? { state: "closed" as PullState } : undefined,
    }),
  );
  assert.deepEqual(staleness.evidence, ["site#1128 is closed, not merged"]);
  assert.deepEqual(errors.map((error) => error.message), [
    "1 reference could not be checked: ext#150",
  ]);
});

test("a precondition that could not be run is recorded as a failure, not as a finding", async () => {
  const { staleness, errors } = await assess(
    aRecord({
      id: "mw-4",
      classification: "yours:access",
      labels: ["needs-access"],
      description: "npm whoami is a 401 on this machine, so nothing can be published.",
    }),
    aContext({ idPrefix: "mw", probe: async () => undefined }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.deepEqual(staleness.evidence, []);
  assert.deepEqual(errors, [
    {
      source: "staleness mw-4",
      message: "1 precondition could not be run: `npm whoami`",
      at: CHECKED_AT.toISOString(),
    },
  ]);
});

test("what the run itself was not configured to do names no issue, so it can be recorded once", async () => {
  const record = {
    classification: "parked:tooling" as const,
    notes: "Blocked until mw-9 lands and https://github.com/404sl/pitwall/pull/12 merges.",
  };
  const first = await assess(aRecord({ id: "mw-4", ...record }), aContext());
  const second = await assess(aRecord({ id: "mw-5", ...record }), aContext());
  assert.deepEqual(first.errors, second.errors, "a run-level failure must not vary by issue");
  assert.deepEqual(
    first.errors.map((error) => [error.source, error.message]),
    [
      ["staleness", "the project records no issue id prefix, so referenced issues cannot be recognised"],
      ["staleness", "no pull request host is configured, so pull requests could not be looked up"],
    ],
  );
});

test("the count a reader is shown is the count the failure recorded", async () => {
  const { errors } = await assess(
    aRecord({ id: "mw-4", classification: "parked:tooling", notes: "Waiting on #141, #142 and #144." }),
    aContext({ idPrefix: "mw", probe: async () => true, pullFacts: async () => undefined }),
  );
  assert.equal(errors.length, 1);
  assert.equal(unresolvedCount(errors[0]?.message ?? ""), 3);
  assert.equal(unresolvedCount("no pull request host is configured, so pull requests could not be looked up"), 0);
});
