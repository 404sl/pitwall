import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, hasLiveStructuralBlocker } from "../src/classify.ts";
import type { ClassifyContext, UnclassifiedIssue } from "../src/classify.ts";
import { preconditionProbe } from "../src/probes.ts";
import { assess, isAssessable } from "../src/staleness.ts";
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
  return {
    id: issue.id,
    title: issue.title,
    classification: classify(issue, context),
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

function pulls(states: Record<string, PullState>): Partial<StalenessContext> {
  return { pullState: async (reference) => states[reference.text] };
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

test("a note written after the parking label reads as an answer", async () => {
  const staleness = await assess(
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
  const staleness = await assess(
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
  const staleness = await assess(
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

test("a tracker that does not record when a label went on says so instead of guessing", async () => {
  const staleness = await assess(
    aRecord({
      classification: "yours:access",
      labels: ["needs-access"],
      notes: "The owner granted the token.",
    }),
    aContext(),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.ok(matches(staleness.evidence, /does not record when the needs-access label was applied/));
});

test("an issue whose every named issue has closed is no longer waiting on the ordering", async () => {
  const staleness = await assess(
    aRecord({ labels: ["blocked-tooling"], classification: "parked:tooling", notes: "Blocked until mw-9 lands." }),
    aContext({ idPrefix: "mw", ...tracker({ "mw-9": "closed" }) }),
  );
  assert.equal(staleness.verdict, "resolved");
  assert.ok(matches(staleness.evidence, /every issue it names has since closed: mw-9/));
});

test("an issue naming an issue that is still open keeps its blocker", async () => {
  const staleness = await assess(
    aRecord({ labels: ["blocked-tooling"], classification: "parked:tooling", notes: "Blocked until mw-9 lands." }),
    aContext({ idPrefix: "mw", ...tracker({ "mw-9": "open" }) }),
  );
  assert.equal(staleness.verdict, "still-blocking");
  assert.ok(matches(staleness.evidence, /it names mw-9, still open/));
});

test("a name the tracker has never heard of is not read as a closed issue", async () => {
  const staleness = await assess(
    aRecord({ classification: "parked:watch", notes: "Raised by mw-devloop in passing." }),
    aContext({ idPrefix: "mw", ...tracker({}) }),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.ok(matches(staleness.evidence, /names no other issue of this project/));
});

test("a referenced pull request that has merged is reported as merged", async () => {
  const staleness = await assess(
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
  const staleness = await assess(
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
  const staleness = await assess(
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
  const staleness = await assess(
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
  const staleness = await assess(
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
  assert.ok(matches(staleness.evidence, /names no condition that can be tested from here/));
});

test("the probe refuses a command that is not on the allow-list without spawning it", async () => {
  const probe = preconditionProbe();
  assert.equal(await probe(["rm", "-rf", "/"]), undefined);
  assert.equal(await probe(["npm", "publish"]), undefined);
});

test("a needs-decision issue is never reported resolved, however many checks fire", async () => {
  const { probe } = answers(true);
  const staleness = await assess(
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

test("an issue nobody has been able to check reports unchecked, with what was looked for", async () => {
  const staleness = await assess(aRecord({ classification: "parked:roadmap" }), aContext());
  assert.equal(staleness.verdict, "unchecked");
  assert.equal(staleness.checkedAt, undefined);
  assert.ok(staleness.evidence.length > 0);
});

test("every verdict carries evidence a person can check by hand", async () => {
  const { probe } = answers(true);
  const records: ParkedRecord[] = [
    aRecord({ classification: "parked:roadmap" }),
    aRecord({ classification: "parked:tooling", notes: "Blocked until mw-9 lands." }),
    aRecord({ classification: "yours:access", description: "npm whoami is a 401 here." }),
    aRecord({ classification: "blocked", notes: "Blocked until mw-8 lands.", blockedBy: ["mw-8"] }),
  ];
  const verdicts = new Set<string>();
  for (const record of records) {
    const staleness = await assess(
      record,
      aContext({ idPrefix: "mw", ...tracker({ "mw-9": "closed", "mw-8": "open" }), probe }),
    );
    verdicts.add(staleness.verdict);
    assert.ok(staleness.evidence.length > 0, `${record.classification} carried no evidence`);
  }
  assert.deepEqual([...verdicts].sort(), ["likely-stale", "resolved", "still-blocking", "unchecked"].sort());
});

test("only an issue that stopped for a reason is worth checking", () => {
  assert.equal(isAssessable("ready"), false);
  assert.equal(isAssessable("in-flight"), false);
  assert.equal(isAssessable("landing"), false);
  assert.equal(isAssessable("blocked"), true);
  assert.equal(isAssessable("parked:watch"), true);
  assert.equal(isAssessable("yours:access"), true);
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
  const staleness = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(!matches(staleness.evidence, /no open dependency of its own remains/));
});

test("an issue with an open child is never reported resolved", async () => {
  const issues = [anIssue("mw-9", { status: "closed" }), anIssue("mw-30"), anIssue("mw-30.1")];
  const record = asRecorded("mw-30", issues, { notes: ANSWERED });
  assert.equal(record.classification, "parked:umbrella");
  assert.equal(record.structurallyBlocked, true);
  const staleness = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
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
  const staleness = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
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
  const staleness = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "likely-stale");
  assert.ok(!matches(staleness.evidence, /no open dependency of its own remains/));
});

test("a parked issue with nothing of its own left open is still reported resolved", async () => {
  const issues = [anIssue("mw-9", { status: "closed" }), anIssue("mw-30", { labels: ["blocked-tooling"] })];
  const record = asRecorded("mw-30", issues, { notes: ANSWERED });
  assert.equal(record.classification, "parked:tooling");
  assert.equal(record.structurallyBlocked, false);
  const staleness = await assess(record, aContext({ idPrefix: "mw", ...trackerOf(issues) }));
  assert.equal(staleness.verdict, "resolved");
  assert.ok(matches(staleness.evidence, /no open dependency of its own remains/));
});

test("a markdown anchor is not read as a pull request reference", async () => {
  const staleness = await assess(
    aRecord({
      classification: "parked:tooling",
      description: "See [the naming section](#3) of docs/style.md before starting.",
    }),
    aContext(pulls({ "#3": "merged" })),
  );
  assert.equal(staleness.verdict, "unchecked");
  assert.ok(matches(staleness.evidence, /it names no pull request/));
});

test("a bare pull number in a merge title is still read as a pull request reference", async () => {
  const staleness = await assess(
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
