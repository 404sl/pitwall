import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Classification, SCHEMA_VERSION, isYours, parseSnapshot } from "@404sl/pitwall-schema";
import type { CollectionError } from "@404sl/pitwall-schema";
import {
  KEPT_SOURCE,
  PARK_SUSPECT_AFTER_MS,
  PARTIAL_SOURCE,
  REFRESH_SOURCE,
  SNAPSHOT_STALE_AFTER_MS,
  blockedSummary,
  buildBoard,
  buildIssueView,
  buildState,
  parkedReasons,
  parkedSummary,
  previewIssue,
  problemKey,
  snapshotAge,
} from "../ui/model.ts";
import type {
  Board,
  BuildState,
  FilterState,
  IssuePayload,
  IssuePreview,
  ProjectAge,
  QuestionStore,
} from "../ui/model.ts";
import { strings } from "../ui/strings.ts";
import { countLabel } from "../ui/format.ts";
import { boardHref, filterOf, filterQuery, issueHref, routeOf, sortOf } from "../ui/routes.ts";
import type { ClassificationReason } from "../src/classify.ts";
import { VERSION } from "../src/version.ts";

register("./support/svg-stub.mjs", import.meta.url);
const { Header } = await import("../ui/components/Header.tsx");
const { BuildBanner, BuildToken } = await import("../ui/components/Build.tsx");

const GENERATED_AT = "2026-09-08T14:11:00Z";
const HEADER_NOW = Date.parse("2026-09-08T14:49:00Z");
const RUNNING_VERSION = VERSION.replace(/\./g, "\\.");

function headerMarkup(
  projectCount: number,
  generatedAt: string,
  update?: string,
  refreshFailure?: CollectionError,
  build?: BuildState,
  projectAges?: ProjectAge[],
): string {
  const realNow = Date.now;
  Date.now = () => HEADER_NOW;
  try {
    return renderToStaticMarkup(
      createElement(Header, {
        projectCount,
        generatedAt,
        version: VERSION,
        update,
        refreshFailure,
        build,
        projectAges,
      }),
    );
  } finally {
    Date.now = realNow;
  }
}

const BUILT_AT = "2026-09-08T20:47:00Z";
const BUILD_NOW = Date.parse("2026-09-10T19:47:00Z");
const BUILT_FROM = "9f2c1ab0000000000000000000000000000000ab";
const CHECKOUT_HEAD = "1a2b3c4000000000000000000000000000000000";

function atBuildNow(render: () => string): string {
  const realNow = Date.now;
  Date.now = () => BUILD_NOW;
  try {
    return render();
  } finally {
    Date.now = realNow;
  }
}

function bannerMarkup(build: BuildState): string {
  return atBuildNow(() => renderToStaticMarkup(createElement(BuildBanner, { build })));
}

function tokenMarkup(build: BuildState): string {
  return atBuildNow(() => renderToStaticMarkup(createElement(BuildToken, { build })));
}

const BEHIND: BuildState = {
  kind: "behind",
  branch: "master",
  ahead: 23,
  head: CHECKOUT_HEAD,
  commit: BUILT_FROM,
  at: BUILT_AT,
};

function headerAged(ms: number, projectCount = 3): string {
  return headerMarkup(projectCount, new Date(HEADER_NOW - ms).toISOString());
}

function issue(id: string, classification: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `title for ${id}`, status: "open", priority: 1, classification, ...extra };
}

function project(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: name,
    name,
    root: `/projects/${name}`,
    authority: { kind: "beads" },
    metrics: {},
    ...fields,
  };
}

function snapshotOf(projects: Array<Record<string, unknown>>, errors: Array<Record<string, unknown>> = []) {
  return parseSnapshot({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: GENERATED_AT,
    agent: { version: VERSION, executor: "local" },
    projects,
    errors,
  });
}

const EVERY_CLASSIFICATION = snapshotOf([
  project("session-replay", {
    issues: Classification.options.map((classification, index) => issue(`sr-${index}`, classification)),
  }),
]);

test("needs you holds exactly the classifications the contract calls yours", () => {
  const board = buildBoard(EVERY_CLASSIFICATION);
  const shown = board.needsYou.flatMap((group) => group.rows.map((row) => row.id)).sort();
  const expected = Classification.options
    .map((classification, index) => ({ classification, id: `sr-${index}` }))
    .filter((entry) => isYours(entry.classification))
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(shown, expected);
  assert.equal(shown.length, 2);
});

test("a parked issue never reaches needs you", () => {
  const board = buildBoard(EVERY_CLASSIFICATION);
  const shown = board.needsYou.flatMap((group) => group.rows.map((row) => row.id));
  const parked = Classification.options
    .map((classification, index) => ({ classification, id: `sr-${index}` }))
    .filter((entry) => entry.classification.startsWith("parked:"))
    .map((entry) => entry.id);
  assert.equal(parked.length, 6);
  for (const id of parked) {
    assert.equal(shown.includes(id), false, `${id} must not be presented as somebody's queue`);
  }
});

test("every needs-you row carries a staleness verdict, unchecked by default", () => {
  const board = buildBoard(
    snapshotOf([
      project("session-replay", {
        issues: [
          issue("sr-i6yt", "yours:decision", { staleness: { verdict: "likely-stale" } }),
          issue("sr-8yyz", "yours:access", { priority: 2 }),
        ],
      }),
    ]),
  );
  const rows = board.needsYou.flatMap((group) => group.rows);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.verdict.length > 0);
  }
  assert.equal(rows[0]?.verdict, "likely-stale");
  assert.equal(rows[1]?.verdict, "unchecked");
});

const DAY = 24 * 60 * 60_000;

function stoppedAt(ms: number) {
  return { since: new Date(Date.parse(GENERATED_AT) - ms).toISOString(), basis: "carried" };
}

const AGED_QUESTIONS: QuestionStore = {
  pitwall: {
    "pitwall-old": "Which one?",
    "pitwall-almost": "Keep it?",
    "pitwall-p0": "Ship?",
    "pitwall-p2": "Ship?",
  },
};

const AGED = snapshotOf([
  project("pitwall", {
    issues: [
      issue("pitwall-p2", "yours:decision", { labels: ["needs-decision"], priority: 2, stopped: stoppedAt(3 * DAY) }),
      issue("pitwall-p0", "yours:decision", { labels: ["needs-decision"], priority: 0, stopped: stoppedAt(3 * DAY) }),
      issue("pitwall-mute", "yours:decision", { labels: ["needs-decision"], priority: 0, stopped: stoppedAt(3 * DAY) }),
      issue("pitwall-almost", "yours:decision", {
        labels: ["needs-decision"],
        stopped: stoppedAt(PARK_SUSPECT_AFTER_MS - 60_000),
      }),
      issue("pitwall-week", "yours:access", { labels: ["needs-access"], stopped: stoppedAt(PARK_SUSPECT_AFTER_MS) }),
      issue("pitwall-old", "yours:decision", { labels: ["needs-decision"], stopped: stoppedAt(11 * DAY) }),
      issue("pitwall-new", "yours:access", { labels: ["needs-access"], priority: 0 }),
      issue("pitwall-t2", "parked:watch", { labels: ["watch"], stopped: stoppedAt(2 * DAY) }),
      issue("pitwall-t1", "parked:tooling", { labels: ["blocked-tooling"], stopped: stoppedAt(9 * DAY) }),
      issue("pitwall-t3", "parked:roadmap", { labels: ["roadmap"], stopped: stoppedAt(8 * DAY) }),
      issue("pitwall-t4", "parked:umbrella", { labels: ["umbrella"] }),
      issue("pitwall-epic", "parked:umbrella", { issueType: "epic" }),
      issue("pitwall-dep", "blocked"),
    ],
  }),
]);

test("the owner's queue is sorted oldest park first, unknown after known, misfiled last, then priority, then id", () => {
  const board = buildBoard(AGED, {}, AGED_QUESTIONS);
  const rows = board.needsYou.flatMap((group) => group.rows);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["pitwall-old", "pitwall-week", "pitwall-almost", "pitwall-p0", "pitwall-p2", "pitwall-mute", "pitwall-new"],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("pitwall-old")?.park.ms, 11 * DAY);
  assert.equal(byId.get("pitwall-old")?.park.suspect, true);
  assert.equal(byId.get("pitwall-old")?.question, "Which one?");
  assert.equal(byId.get("pitwall-old")?.misfiled, false);
  assert.equal(byId.get("pitwall-week")?.park.suspect, true, "a park at exactly the threshold is suspect");
  assert.equal(byId.get("pitwall-almost")?.park.suspect, false, "a minute under the threshold is not");
  assert.equal(byId.get("pitwall-mute")?.misfiled, true, "a decision with no stated question is misfiled");
  assert.equal(byId.get("pitwall-mute")?.kind, "decision", "misfiled is rendering, not classification");
  assert.deepEqual(byId.get("pitwall-new")?.park, { suspect: false }, "a park the document has not dated is unknown");
  assert.equal(byId.get("pitwall-new")?.misfiled, false, "an unplaced park cannot be judged misfiled");
  assert.equal(board.needsYouCount, rows.length, "a misfiled row still counts: the count is the classification's");
  assert.equal(board.totals.needsYou, 7);
});

test("only a park a label put on is aged, and a structural one is neither aged nor listed", () => {
  const board = buildBoard(AGED, {}, AGED_QUESTIONS);
  const listed = [...board.parkedRows.suspect, ...board.parkedRows.rest].flatMap((group) => group.rows);
  assert.deepEqual(
    listed.map((row) => row.id),
    ["pitwall-t1", "pitwall-t3", "pitwall-t2", "pitwall-t4"],
    "oldest first, and the unknown-age umbrella last",
  );
  assert.deepEqual(
    board.parkedRows.suspect.flatMap((group) => group.rows.map((row) => [row.id, row.reason])),
    [
      ["pitwall-t1", "tooling"],
      ["pitwall-t3", "roadmap"],
    ],
  );
  assert.deepEqual(
    board.parkedRows.rest.flatMap((group) => group.rows.map((row) => row.id)),
    ["pitwall-t2", "pitwall-t4"],
  );
  assert.equal(listed.some((row) => row.id === "pitwall-epic" || row.id === "pitwall-dep"), false);
  assert.deepEqual(board.parked, [
    { reason: "tooling", count: 1 },
    { reason: "watch", count: 1 },
    { reason: "umbrella", count: 2 },
    { reason: "roadmap", count: 1 },
    { reason: "blocked", count: 1 },
  ]);
  assert.equal(
    Object.entries(board).some(([key, value]) => key.toLowerCase().includes("parked") && typeof value === "number"),
    false,
  );
  const blocked = buildBoard(
    snapshotOf([
      project("maas", {
        issues: [
          issue("maas-b1", "blocked", { stopped: stoppedAt(30 * DAY) }),
          issue("maas-e", "parked:umbrella", { issueType: "epic", stopped: stoppedAt(30 * DAY) }),
        ],
      }),
    ]),
  );
  assert.deepEqual(blocked.parkedRows, { suspect: [], rest: [] });
  assert.deepEqual(blocked.needsYou, []);
  assert.deepEqual(blocked.ready, []);
  assert.deepEqual(blocked.running, []);
});

test("the parked tables follow the shown projects like every band, and the summary keeps its counts", () => {
  const two = snapshotOf([
    project("pitwall", { issues: [issue("pitwall-t1", "parked:tooling", { labels: ["blocked-tooling"], stopped: stoppedAt(9 * DAY) })] }),
    project("maas", { issues: [issue("maas-t1", "parked:tooling", { labels: ["blocked-tooling"], stopped: stoppedAt(9 * DAY) })] }),
  ]);
  const board = buildBoard(two, { project: "maas" });
  assert.deepEqual(board.parkedRows.suspect.map((group) => group.projectId), ["maas"]);
  assert.deepEqual(board.parked, [{ reason: "tooling", count: 1 }]);
  assert.deepEqual(board.totals.parked, [{ reason: "tooling", count: 2 }]);
});

test("the issue preview carries the park age the document dates and the question the store recorded", () => {
  const preview = previewIssue(AGED, "pitwall", "pitwall-old", AGED_QUESTIONS);
  assert.equal(preview?.park?.ms, 11 * DAY);
  assert.equal(preview?.park?.suspect, true);
  assert.equal(preview?.question, "Which one?");
  const unplaced = previewIssue(AGED, "pitwall", "pitwall-new", AGED_QUESTIONS);
  assert.deepEqual(unplaced?.park, { suspect: false });
  assert.equal(previewIssue(AGED, "pitwall", "pitwall-epic", AGED_QUESTIONS)?.park, undefined, "no label, no age");
  assert.equal(previewIssue(AGED, "pitwall", "pitwall-dep", AGED_QUESTIONS)?.park, undefined);
});

test("parked is counted per reason and never summed", () => {
  const counts: Record<string, number> = {
    "parked:tooling": 3,
    "parked:watch": 2,
    "parked:umbrella": 4,
    "parked:roadmap": 6,
    blocked: 5,
  };
  const issues = Object.entries(counts).flatMap(([classification, count]) =>
    Array.from({ length: count }, (_, index) => issue(`${classification}-${index}`, classification)),
  );
  const board = buildBoard(snapshotOf([project("session-replay", { issues })]));
  assert.deepEqual(
    board.parked,
    [
      { reason: "tooling", count: 3 },
      { reason: "watch", count: 2 },
      { reason: "umbrella", count: 4 },
      { reason: "roadmap", count: 6 },
      { reason: "blocked", count: 5 },
    ],
  );
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  assert.equal(total, 20);
  const summary = parkedSummary(board.parked);
  assert.equal(summary.includes(String(total)), false, "a combined parked total must never be rendered");
  for (const entry of board.parked) {
    assert.deepEqual(Object.keys(entry).sort(), ["count", "reason"]);
  }
  assert.equal(parkedSummary(board.parked), "tooling 3 \u00b7 watch 2 \u00b7 umbrella 4 \u00b7 roadmap 6");
  assert.equal(
    parkedSummary(board.parked).includes("blocked"),
    false,
    "blocked must not be joined into the parked reasons",
  );
  assert.equal(blockedSummary(board.parked), "blocked 5");
  assert.equal(blockedSummary(board.parked).includes(String(total)), false);
  assert.equal(
    Object.entries(board).some(([key, value]) => key.toLowerCase().includes("parked") && typeof value === "number"),
    false,
    "the board must carry no scalar parked figure",
  );
});

test("parked reasons come from the contract enum rather than a local list", () => {
  const fromContract = Classification.options
    .filter((option) => option.startsWith("parked:"))
    .map((option) => option.slice("parked:".length));
  assert.deepEqual(parkedReasons(), [...fromContract, "blocked", "unknown"]);
});

test("blocked is counted with the parked reasons and appears in no other band", () => {
  const board = buildBoard(
    snapshotOf([project("maas", { issues: [issue("maas-b1", "blocked"), issue("maas-b2", "blocked")] })]),
  );
  assert.deepEqual(board.parked, [{ reason: "blocked", count: 2 }]);
  assert.deepEqual(board.needsYou, []);
  assert.deepEqual(board.running, []);
  assert.deepEqual(board.ready, []);
  assert.deepEqual(board.problems, []);
});

test("unknown is counted with the parked reasons rather than dropped from the board", () => {
  const board = buildBoard(
    snapshotOf([
      project("maas", {
        issues: [issue("maas-u1", "unknown"), issue("maas-u2", "unknown"), issue("maas-b1", "blocked"), issue("maas-r1", "ready")],
        errors: [{ source: "/maas/.beads", message: "bd list --all --limit 0 --json: timed out", at: "2026-09-08T14:09:00Z" }],
      }),
    ]),
  );
  assert.deepEqual(board.parked, [
    { reason: "blocked", count: 1 },
    { reason: "unknown", count: 2 },
  ]);
  assert.equal(board.readyCount, 1);
  assert.equal(board.needsYou.length, 0);
  assert.deepEqual(board.running, []);
  assert.equal(board.issueCount, 4);
  assert.equal(parkedSummary(board.parked), "unknown 2");
  assert.equal(blockedSummary(board.parked), "blocked 1");
});

test("a project that could not be read renders in problems and in no other band", () => {
  const board = buildBoard(
    snapshotOf(
      [
        project("maas", {
          issues: [],
          errors: [{ source: "bd list --status open", message: "exited 1", at: "2026-09-08T14:09:00Z" }],
        }),
        project("session-replay", { issues: [issue("sr-w23d", "ready")] }),
      ],
      [{ source: "workspace scan", message: "two roots claim the same tracker", at: "2026-09-08T14:10:00Z" }],
    ),
  );
  assert.equal(board.problems.length, 2);
  assert.equal(board.problems[0]?.scope, "run");
  assert.equal(board.problems[1]?.name, "maas");
  assert.equal(board.problems[1]?.message, "exited 1");
  const named = [
    ...board.needsYou.map((group) => group.project),
    ...board.running.map((row) => row.project),
    ...board.ready.map((row) => row.project),
  ];
  assert.equal(named.includes("maas"), false, "an unreadable project must not look like a project with no work");
  assert.equal(board.projectCount, 2);
});

test("band counts are the row counts, whatever the metrics claim", () => {
  const board = buildBoard(
    snapshotOf([
      project("session-replay", {
        metrics: { inboxCount: 74, readyCount: 12 },
        issues: [issue("sr-i6yt", "yours:decision"), issue("sr-w23d", "ready"), issue("sr-24l1", "in-flight")],
        lanes: [{ slot: 1, state: "working", issueId: "sr-24l1", lastActivityAt: "2026-09-08T12:59:00Z" }],
      }),
    ]),
  );
  assert.equal(board.needsYouCount, board.needsYou.flatMap((group) => group.rows).length);
  assert.equal(board.needsYouCount, 1);
  assert.equal(board.readyCount, board.ready.length);
  assert.equal(board.readyCount, 1);
  assert.deepEqual(board.runningTotals, [{ state: "working", count: 1 }]);
  assert.equal(board.running[0]?.chips[0]?.elapsedMs, 72 * 60_000);
});

test("ready is capped for reading but the count stays the true total", () => {
  const issues = Array.from({ length: 12 }, (_, index) => issue(`sr-r${String(index).padStart(2, "0")}`, "ready"));
  const board = buildBoard(snapshotOf([project("session-replay", { issues })]));
  assert.equal(board.readyCount, 12);
  assert.equal(board.ready.length, 8);
  assert.equal(board.readyShown, 8);
});

test("a lane with no recorded activity reports no elapsed time", () => {
  const board = buildBoard(
    snapshotOf([
      project("pitwall", {
        issues: [
          issue("pitwall-0lm", "in-flight"),
          issue("pitwall-zii", "landing"),
          issue("pitwall-9wq", "landing", { status: "in_progress" }),
        ],
        lanes: [
          { slot: 1, state: "working", issueId: "pitwall-0lm" },
          { slot: 2, state: "handed-off", issueId: "pitwall-zii", lastActivityAt: "2026-09-08T13:56:00Z" },
          { slot: 3, state: "stranded", issueId: "pitwall-9wq", lastActivityAt: "2026-09-06T13:11:00Z" },
        ],
      }),
    ]),
  );
  assert.deepEqual(
    board.running.map((row) => [row.state, row.count]),
    [
      ["working", 1],
      ["awaiting-lander", 1],
      ["stranded", 1],
    ],
  );
  assert.equal(board.running[0]?.chips[0]?.elapsedMs, undefined);
  assert.equal(board.running[2]?.chips[0]?.id, "pitwall-9wq");
  assert.equal(board.running[2]?.chips[0]?.slot, 3);
  assert.deepEqual(
    board.runningTotals.map((total) => total.state),
    ["working", "awaiting-lander", "stranded"],
  );
});

test("a lane the tracker did not report still counts, and never as zero", () => {
  const board = buildBoard(
    snapshotOf([
      project("maas", {
        issues: [],
        errors: [{ source: "bd list --status open", message: "exited 1", at: "2026-09-08T14:09:00Z" }],
        lanes: [{ slot: 1, state: "working", issueId: "maas-abc", lastActivityAt: "2026-09-08T12:59:00Z" }],
      }),
    ]),
  );
  assert.deepEqual(
    board.running.map((row) => [row.project, row.state, row.count]),
    [["maas", "working", 1]],
  );
  assert.deepEqual(board.runningTotals, [{ state: "working", count: 1 }]);
  assert.equal(board.problems.length, 1);
});

test("no running row prints a count beneath the lanes it shows", () => {
  const board = buildBoard(
    snapshotOf([
      project("maas", {
        issues: [],
        lanes: [
          { slot: 1, state: "working", issueId: "maas-abc", lastActivityAt: "2026-09-08T13:59:00Z" },
          { slot: 2, state: "handed-off", issueId: "maas-def", lastActivityAt: "2026-09-08T13:11:00Z" },
        ],
      }),
      project("session-replay", {
        issues: [issue("sr-1", "in-flight"), issue("sr-2", "in-flight"), issue("sr-3", "landing")],
        lanes: [{ slot: 1, state: "working", issueId: "sr-1", lastActivityAt: "2026-09-08T13:00:00Z" }],
      }),
    ]),
  );
  for (const row of board.running) {
    assert.ok(row.count >= row.chips.length, `${row.project} ${row.state} counts fewer than the lanes it shows`);
    assert.ok(row.count > 0, `${row.project} ${row.state} renders a row with no count`);
  }
  assert.deepEqual(
    board.running.map((row) => [row.project, row.state, row.count]),
    [
      ["session-replay", "working", 2],
      ["session-replay", "awaiting-lander", 1],
      ["maas", "working", 1],
      ["maas", "awaiting-lander", 1],
    ],
  );
  assert.deepEqual(board.runningTotals, [
    { state: "working", count: 3 },
    { state: "awaiting-lander", count: 2 },
  ]);
});

test("a lane that died counts once, not once as a lane and once again as its issue", () => {
  const board = buildBoard(
    snapshotOf([
      project("session-replay", {
        issues: [issue("sr-9wq0", "landing", { status: "in_progress" })],
        lanes: [{ slot: 1, state: "stranded", issueId: "sr-9wq0", lastActivityAt: "2026-09-08T09:11:00Z" }],
      }),
    ]),
  );
  assert.deepEqual(
    board.running.map((row) => [row.project, row.state, row.count]),
    [["session-replay", "stranded", 1]],
  );
  assert.equal(board.running[0]?.chips[0]?.id, "sr-9wq0");
  assert.deepEqual(board.runningTotals, [{ state: "stranded", count: 1 }]);
  assert.equal(
    board.runningTotals.reduce((sum, total) => sum + total.count, 0),
    1,
    "one piece of work must be counted once across the running states",
  );
  assert.equal(
    board.running.some((row) => row.state === "awaiting-lander"),
    false,
    "a claimed issue must not raise a second row beside the lane holding it",
  );
  for (const row of board.running) {
    assert.ok(row.chips.length > 0, `${row.state} prints a count with no lane beside it`);
  }
});

function payload(over: Partial<IssuePayload["issue"]> = {}, snapshot?: IssuePayload["snapshot"]): IssuePayload {
  return {
    issue: {
      id: "sr-i6yt",
      title: "Honour paid checkout?",
      status: "open",
      labels: [],
      project: "session-replay",
      projectName: "session-replay",
      authority: { kind: "beads" },
      blockedBy: [],
      blocks: [],
      classification: "yours:decision",
      reason: { rule: "label", label: "needs-decision" },
      staleness: { verdict: "unchecked", evidence: [] },
      ...over,
    },
    readAt: "2026-09-08T14:20:00Z",
    snapshot,
  };
}

test("an unchecked verdict is not a checked one, and carries no evidence to act on", () => {
  const unchecked = buildIssueView(payload()).staleness;
  assert.equal(unchecked.verdict, "unchecked");
  assert.equal(unchecked.checked, false);
  assert.deepEqual(unchecked.evidence, []);

  const checked = buildIssueView(
    payload({
      staleness: {
        verdict: "still-blocking",
        checkedAt: "2026-09-08T13:00:00Z",
        evidence: ["sr-8yyz is still open"],
      },
    }),
  ).staleness;
  assert.equal(checked.checked, true);
  assert.equal(checked.checkedAt, "2026-09-08T13:00:00Z");
  assert.deepEqual(checked.evidence, ["sr-8yyz is still open"]);
});

test("an issue closed since the snapshot is flagged rather than shown as current", () => {
  const closed = buildIssueView(
    payload({ status: "closed" }, { generatedAt: GENERATED_AT, status: "open" }),
  );
  assert.equal(closed.closedSinceSnapshot, true);
  assert.equal(closed.issue.status, "closed", "the reading, not the snapshot, is what the page shows");
  assert.equal(closed.snapshot?.status, "open", "the snapshot's own value stays labelled as the snapshot's");
});

test("nothing is flagged as newly closed when the snapshot never held the issue, or already knew", () => {
  assert.equal(buildIssueView(payload({ status: "closed" })).closedSinceSnapshot, false);
  assert.equal(
    buildIssueView(payload({ status: "closed" }, { generatedAt: GENERATED_AT, status: "closed" }))
      .closedSinceSnapshot,
    false,
  );
  assert.equal(
    buildIssueView(payload({}, { generatedAt: GENERATED_AT, status: "open" })).closedSinceSnapshot,
    false,
  );
});

test("a closed reading is marked closed and carries no classification to render", () => {
  const closed = buildIssueView(
    payload({ status: "closed", classification: undefined, reason: { rule: "closed" } }),
  );
  assert.equal(closed.closed, true);
  assert.equal(closed.issue.classification, undefined);
  assert.deepEqual(closed.issue.reason, { rule: "closed" });
  assert.equal(closed.staleness.checked, false, "a closed issue falls back to the unchecked verdict");
  assert.equal(buildIssueView(payload()).closed, false);
});

test("a closed issue keeps the snapshot's checked verdict and the evidence under it", () => {
  const closed = buildIssueView(
    payload(
      {
        status: "closed",
        classification: undefined,
        reason: { rule: "closed" },
        staleness: {
          verdict: "still-blocking",
          checkedAt: "2026-09-08T13:02:00Z",
          evidence: ["sr-8yyz is still open"],
        },
      },
      { generatedAt: GENERATED_AT, status: "open" },
    ),
  );
  assert.equal(closed.closed, true);
  assert.equal(closed.closedSinceSnapshot, true);
  assert.equal(closed.staleness.checked, true, "a verdict the snapshot recorded is not downgraded to unchecked");
  assert.equal(closed.staleness.verdict, "still-blocking");
  assert.equal(closed.staleness.checkedAt, "2026-09-08T13:02:00Z");
  assert.deepEqual(closed.staleness.evidence, ["sr-8yyz is still open"]);
});

test("every board row carries the project the link to its page needs", () => {
  const board = buildBoard(
    snapshotOf([
      project("session-replay", {
        issues: [
          issue("sr-i6yt", "yours:decision"),
          issue("sr-w23d", "ready"),
          issue("sr-24l1", "in-flight", { status: "in_progress" }),
        ],
        lanes: [{ slot: 1, state: "working", issueId: "sr-24l1" }],
      }),
    ]),
  );
  assert.deepEqual(
    board.needsYou.map((group) => group.projectId),
    ["session-replay"],
  );
  assert.deepEqual(
    board.ready.map((row) => row.projectId),
    ["session-replay"],
  );
  assert.deepEqual(
    board.running.map((row) => row.projectId),
    ["session-replay"],
  );
});

test("an issue link survives a round trip, ids and project names included", () => {
  assert.equal(issueHref("session-replay", "sr-w23d.3"), "#/issue/session-replay/sr-w23d.3");
  assert.deepEqual(routeOf(issueHref("a project", "sr/1")), { project: "a project", id: "sr/1" });
  assert.equal(routeOf("#/"), undefined);
  assert.equal(routeOf(""), undefined);
  assert.equal(routeOf("#/issue/session-replay"), undefined);
  assert.equal(routeOf("#/issue//sr-1"), undefined);
  assert.equal(routeOf("#/issue/session-replay/sr-1/extra"), undefined);
});

test("the header reads the snapshot as an age, not as a clock time", () => {
  const now = Date.parse("2026-09-08T14:49:00Z");
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(snapshotAge(at(0), now).label, "<1m");
  assert.equal(snapshotAge(at(9), now).label, "9m");
  assert.equal(snapshotAge(at(38), now).label, "38m");
  assert.equal(snapshotAge(at(125), now).label, "2h5m");
});

test("a snapshot goes loud only once it is stale enough to act on by mistake", () => {
  const now = Date.parse("2026-09-08T14:49:00Z");
  const olderBy = (ms: number) => snapshotAge(new Date(now - ms).toISOString(), now);
  assert.equal(SNAPSHOT_STALE_AFTER_MS, 600_000);
  assert.equal(olderBy(SNAPSHOT_STALE_AFTER_MS - 1_000).stale, false, "9m59s must stay grey");
  assert.equal(olderBy(SNAPSHOT_STALE_AFTER_MS).stale, true, "the threshold itself is stale");
  assert.equal(olderBy(38 * 60_000).stale, true);
  assert.equal(olderBy(38 * 60_000).label, "38m");
});

test("an age that cannot be read never claims the snapshot is stale", () => {
  const now = Date.parse("2026-09-08T14:49:00Z");
  const unreadable = snapshotAge("not-a-date", now);
  assert.equal(unreadable.valid, false);
  assert.equal(unreadable.stale, false);
  assert.equal(unreadable.label, "not-a-date");

  const skewed = snapshotAge(new Date(now + 5 * 60_000).toISOString(), now);
  assert.equal(skewed.valid, true);
  assert.equal(skewed.stale, false);
  assert.equal(skewed.label, "<1m");
});

test("the rendered header reads the snapshot as an age and keeps the exact instant reachable", () => {
  const generatedAt = new Date(HEADER_NOW - 4 * 60_000).toISOString();
  const markup = headerMarkup(3, generatedAt);
  assert.match(markup, /<span class="pw-header__age">4m old<\/span>/);
  assert.match(markup, /3 projects · /);
  assert.match(markup, /<p class="pw-header__meta" title="[^"]+"/);
  assert.match(markup, new RegExp(`<time class="pw-sr" dateTime="${generatedAt}">`));
});

test("the rendered header stays grey below the staleness threshold and goes loud at it", () => {
  const fresh = headerAged(SNAPSHOT_STALE_AFTER_MS - 1_000);
  assert.match(fresh, /<header class="pw-header">/);
  assert.doesNotMatch(fresh, /pw-header--stale/);
  assert.match(fresh, /<span class="pw-header__flag" role="status"><\/span>/);
  assert.doesNotMatch(fresh, /stale/);

  const stale = headerAged(SNAPSHOT_STALE_AFTER_MS);
  assert.match(stale, /<header class="pw-header pw-header--stale">/);
  assert.match(stale, /<span aria-hidden="true"> · stale<\/span>/);
  assert.match(stale, /<span class="pw-sr">Snapshot is stale\. It may no longer be true\.<\/span>/);
});

test("a refresh that has just failed reads differently from a snapshot that is merely stale", () => {
  const failed = headerMarkup(3, new Date(HEADER_NOW - 2 * 60_000).toISOString(), undefined, {
    source: REFRESH_SOURCE,
    message: "No project could be read.",
    at: GENERATED_AT,
  });
  assert.match(failed, /<header class="pw-header pw-header--stale">/);
  assert.match(failed, /<span class="pw-header__age">2m old<\/span>/);
  assert.match(failed, /<span aria-hidden="true"> · refresh failed<\/span>/);
  assert.match(
    failed,
    /<span class="pw-sr">The last refresh failed\. This board is 2m old and is not being updated\.<\/span>/,
  );
  assert.doesNotMatch(failed, / · stale</);

  const stale = headerAged(SNAPSHOT_STALE_AFTER_MS);
  assert.doesNotMatch(stale, /refresh failed/);
  assert.match(stale, /<span aria-hidden="true"> · stale<\/span>/);
});

test("a partly collected board is flagged without telling anybody it stopped updating", () => {
  const message = "1 of 2 projects could not be read: brochure (issues kept from the last snapshot).";
  const partial = headerMarkup(2, new Date(HEADER_NOW - 2 * 60_000).toISOString(), undefined, {
    source: PARTIAL_SOURCE,
    message,
    at: GENERATED_AT,
  });
  assert.match(partial, /<span aria-hidden="true"> · refresh failed<\/span>/);
  assert.match(partial, new RegExp(`<span class="pw-sr">${message.replace(/[.()]/g, "\\$&")}</span>`));
  assert.doesNotMatch(partial, /is not being updated/);
});

test("a board carrying a re-collection failure flags it and lists it under problems", () => {
  const failing = snapshotOf(
    [project("pitwall")],
    [{ source: REFRESH_SOURCE, message: "bd is not on PATH", at: GENERATED_AT }],
  );
  const board = buildBoard(failing);
  assert.equal(board.refreshFailure?.message, "bd is not on PATH");
  assert.ok(board.problems.some((row) => row.scope === "run" && row.source === REFRESH_SOURCE));
  assert.equal(buildBoard(snapshotOf([project("pitwall")])).refreshFailure, undefined);
});

test("the header names the version it is serving, and says nothing about an update it has not confirmed", () => {
  const markup = headerAged(60_000);
  assert.match(markup, new RegExp(`<span class="pw-sr">version </span>${RUNNING_VERSION}<span`));
  assert.match(markup, /<span class="pw-header__update" role="status"><\/span>/);
  assert.doesNotMatch(markup, /available/);
});

test("a confirmed newer release is named beside the running version", () => {
  const markup = headerMarkup(3, new Date(HEADER_NOW - 60_000).toISOString(), "0.1.99");
  assert.match(markup, new RegExp(`</span>${RUNNING_VERSION}<span class="pw-header__update" role="status">`));
  assert.match(markup, /<span aria-hidden="true"> · <\/span>0\.1\.99 available<\/span>/);
});

const KEPT_READ_AT = new Date(Date.parse(GENERATED_AT) - 2 * 24 * 60 * 60_000).toISOString();

function keptProject(name: string, readAt: string): Record<string, unknown> {
  return project(name, {
    issuesReadAt: readAt,
    errors: [
      {
        source: KEPT_SOURCE,
        message: "2 issues kept from the last collection that could read this project.",
        at: readAt,
      },
    ],
  });
}

const PARTIAL_RUN = {
  source: PARTIAL_SOURCE,
  message: "1 of 2 projects could not be read: brochure (issues kept from the last snapshot).",
  at: GENERATED_AT,
};

test("a board where one project was kept and another read shows each project's own age, oldest first", () => {
  const mixed = snapshotOf(
    [project("pitwall", { issuesReadAt: GENERATED_AT }), keptProject("brochure", KEPT_READ_AT)],
    [PARTIAL_RUN],
  );
  const board = buildBoard(mixed);
  assert.deepEqual(board.projectAges, [
    { project: "brochure", projectId: "brochure", readAt: KEPT_READ_AT },
    { project: "pitwall", projectId: "pitwall", readAt: GENERATED_AT },
  ]);
  const markup = headerMarkup(2, GENERATED_AT, undefined, board.refreshFailure, undefined, board.projectAges);
  assert.match(markup, /<header class="pw-header pw-header--stale">/);
  assert.match(markup, /<span class="pw-header__age">38m old<\/span>/);
  assert.match(markup, /<span aria-hidden="true"> · refresh failed<\/span>/);
  assert.match(markup, /<ul class="pw-header__ages" aria-label="Age by project">/);
  assert.match(
    markup,
    /<li class="pw-header__project"><span class="pw-header__project-name">brochure<\/span> <span class="pw-age" title="[^"]+">2d0h<\/span><time class="pw-sr" dateTime="2026-09-06T14:11:00.000Z">brochure issues read [^<]+\.<\/time><\/li>/,
  );
  assert.match(
    markup,
    /<li class="pw-header__project"><span aria-hidden="true"> · <\/span><span class="pw-header__project-name">pitwall<\/span> <span class="pw-age" title="[^"]+">38m<\/span><time class="pw-sr" dateTime="2026-09-08T14:11:00Z">pitwall issues read [^<]+\.<\/time><\/li>/,
  );
  assert.match(markup, /<\/p><ul class="pw-header__ages"/, "the ages sit beside the meta line, not inside it");
});

test("a board whose projects were all read in the same run keeps one age", () => {
  const read = snapshotOf([
    project("pitwall", { issuesReadAt: GENERATED_AT }),
    project("brochure", { issuesReadAt: GENERATED_AT }),
  ]);
  const board = buildBoard(read);
  assert.deepEqual(board.projectAges, []);
  const markup = headerMarkup(2, GENERATED_AT, undefined, undefined, undefined, board.projectAges);
  assert.doesNotMatch(markup, /pw-header__ages/);
  assert.equal(markup, headerMarkup(2, GENERATED_AT));
});

test("a snapshot from a producer that never dated its projects renders the header it always did", () => {
  const board = buildBoard(snapshotOf([project("pitwall"), project("brochure")]));
  assert.deepEqual(board.projectAges, []);
  const markup = headerMarkup(2, GENERATED_AT, undefined, undefined, undefined, board.projectAges);
  assert.equal(markup, headerMarkup(2, GENERATED_AT));
  assert.doesNotMatch(markup, /pw-header__ages/);
});

test("a project with no read date sorts after the dated ones and claims no age", () => {
  const board = buildBoard(
    snapshotOf([project("brochure"), project("pitwall", { issuesReadAt: GENERATED_AT }), project("docs")]),
  );
  assert.deepEqual(board.projectAges, [
    { project: "pitwall", projectId: "pitwall", readAt: GENERATED_AT },
    { project: "brochure", projectId: "brochure" },
    { project: "docs", projectId: "docs" },
  ]);
  const unknown = /<span class="pw-age" title="When this project&#x27;s issues were read is not recorded\.">—<\/span><\/li>/;
  const markup = headerMarkup(3, GENERATED_AT, undefined, undefined, undefined, board.projectAges);
  assert.match(markup, /<span class="pw-header__project-name">pitwall<\/span> <span class="pw-age" title="[^"]+">38m<\/span><time/);
  assert.match(markup, new RegExp(`<span class="pw-header__project-name">brochure</span> ${unknown.source}`));
  assert.match(markup, new RegExp(`<span class="pw-header__project-name">docs</span> ${unknown.source}`));
  assert.equal((markup.match(/<time/g) ?? []).length, 2, "the run and the one dated project, nothing else");

  const unreadable = headerMarkup(1, GENERATED_AT, undefined, undefined, undefined, [
    { project: "docs", projectId: "docs", readAt: "yesterday" },
  ]);
  assert.match(unreadable, new RegExp(`<span class="pw-header__project-name">docs</span> ${unknown.source}`));
  assert.doesNotMatch(unreadable, /yesterday/);
});

test("a header rendered from a stamp it cannot read shows the stamp and claims nothing about it", () => {
  const markup = headerMarkup(1, "not-a-date");
  assert.match(markup, /1 project · /);
  assert.match(markup, /<span class="pw-header__age">not-a-date<\/span>/);
  assert.doesNotMatch(markup, /pw-header--stale/);
  assert.doesNotMatch(markup, /<time/);
});


test("a server that answers without build fields leaves the console unknown, never current", () => {
  const answered = buildState({ kind: "read", version: { running: VERSION } });
  assert.equal(answered.kind, "unknown");
  assert.notEqual(answered.kind, "current");
  assert.equal(answered.kind === "unknown" ? answered.because : "", strings.build.unknown.noServer);
});

test("a version route that answered nothing at all is unknown too, and waiting is neither", () => {
  const unanswered = buildState({ kind: "unanswered" });
  assert.equal(unanswered.kind, "unknown");
  assert.notEqual(unanswered.kind, "current");
  assert.equal(buildState({ kind: "waiting" }).kind, "absent");
});

test("a checkout that could not be read is named as the reason rather than counted as current", () => {
  const failed = buildState({
    kind: "read",
    version: {
      running: VERSION,
      build: { commit: BUILT_FROM, at: BUILT_AT },
      buildCheck: "unknown",
      unknownBecause: { kind: "checkout", message: "fatal: not a git repository" },
    },
  });
  assert.equal(failed.kind, "unknown");
  assert.equal(
    failed.kind === "unknown" ? failed.because : "",
    "The checkout could not be read: fatal: not a git repository",
  );
});

test("a build the checkout has never heard of reads as diverged, naming the commit and the branch", () => {
  const diverged = buildState({
    kind: "read",
    version: {
      running: VERSION,
      build: { commit: BUILT_FROM },
      checkout: { branch: "master", head: CHECKOUT_HEAD },
      buildCheck: "unknown",
      unknownBecause: { kind: "diverged" },
    },
  });
  assert.equal(diverged.kind, "unknown");
  assert.equal(diverged.kind === "unknown" ? diverged.because : "", "The build commit 9f2c1ab is not in master.");
});

test("a board served by a stale build names the count, the branch and both commits", () => {
  const markup = bannerMarkup(BEHIND);
  assert.match(markup, /23 commits on master are not in this console\./);
  assert.match(markup, /Serving a build made 1d23h ago, at 9f2c1ab\./);
  assert.match(markup, /master is at 1a2b3c4\./);
  assert.match(markup, /Restart pitwall serve to pick them up\./);
  assert.match(markup, /class="pw-call pw-call--yours pw-build__head"/);
  assert.match(markup, new RegExp(`datetime="${BUILT_AT}"`, "i"));
});

test("one commit behind is one commit, not '1 commits'", () => {
  const markup = bannerMarkup({ ...BEHIND, ahead: 1 });
  assert.match(markup, /1 commit on master is not in this console\./);
  assert.match(markup, /Restart pitwall serve to pick it up\./);
  assert.doesNotMatch(markup, /1 commits/);
  assert.doesNotMatch(markup, /pick them up/);
});

test("a build that records no time still names what it is serving rather than going silent", () => {
  const markup = bannerMarkup({ kind: "behind", branch: "master", ahead: 2, head: CHECKOUT_HEAD, commit: BUILT_FROM });
  assert.match(markup, /Serving a build that records no time, at 9f2c1ab\./);
  assert.doesNotMatch(markup, /<time/);
});

test("a console that cannot tell says so on the board and declines to claim it is up to date", () => {
  const markup = bannerMarkup({ kind: "unknown", commit: BUILT_FROM, at: BUILT_AT, because: "The server did not report its build." });
  assert.match(markup, /Cannot tell whether this console is serving the current build\./);
  assert.match(markup, /That is not the same as up to date\./);
  assert.match(markup, /<span class="pw-call__ask-label">Reason<\/span>/);
  assert.match(markup, /The server did not report its build\./);
  assert.match(markup, /class="pw-call pw-call--waiting pw-build__head"/);
  assert.doesNotMatch(markup, /pw-call--yours/);
});

test("an unknown with nothing stamped names the reason without inventing a commit", () => {
  const markup = bannerMarkup({ kind: "unknown", because: strings.build.unknown.noStamp });
  assert.match(markup, /This build records no commit\./);
  assert.doesNotMatch(markup, /Serving a build/);
  assert.doesNotMatch(markup, /title=/);
});

test("the banner stays off the board when the build is current, installed, or not yet answered", () => {
  assert.equal(bannerMarkup({ kind: "current", branch: "master", commit: BUILT_FROM, at: BUILT_AT }), "");
  assert.equal(bannerMarkup({ kind: "no-checkout", commit: BUILT_FROM, at: BUILT_AT }), "");
  assert.equal(bannerMarkup({ kind: "absent" }), "");
});

test("the header token tells current apart from a console that has no such check", () => {
  assert.match(tokenMarkup({ kind: "current", branch: "master", commit: BUILT_FROM, at: BUILT_AT }), /9f2c1ab/);
  assert.match(
    tokenMarkup({ kind: "current", branch: "master", commit: BUILT_FROM }),
    /<span class="pw-header__build-state" role="status"><span aria-hidden="true"> · <\/span>current<\/span>/,
  );
  assert.match(
    tokenMarkup({ kind: "no-checkout", commit: BUILT_FROM }),
    /<span class="pw-header__build-state" role="status"><\/span>/,
  );
  assert.doesNotMatch(tokenMarkup({ kind: "no-checkout", commit: BUILT_FROM }), /current/);
});

test("the header token counts the commits it is behind, and reads unknown rather than current", () => {
  assert.match(
    tokenMarkup(BEHIND),
    /<span class="pw-header__build-state pw-header__build-state--behind" role="status"><span aria-hidden="true"> · <\/span>23 behind<\/span>/,
  );
  assert.match(tokenMarkup({ ...BEHIND, ahead: 1 }), /> · <\/span>1 behind</);
  assert.doesNotMatch(tokenMarkup({ ...BEHIND, ahead: 1 }), /1 behinds/);
  assert.match(
    tokenMarkup({ kind: "unknown", because: strings.build.unknown.noServer }),
    /<span class="pw-header__build-state pw-header__build-state--unknown" role="status"><span aria-hidden="true"> · <\/span>unknown<\/span>/,
  );
});

test("the live region is in the header before the first answer arrives, so the answer announces", () => {
  const markup = tokenMarkup({ kind: "absent" });
  assert.equal(markup, '<span class="pw-header__build-state" role="status"></span>');
  assert.doesNotMatch(markup, /pw-header__build"/);
});

test("the build token is rendered beside the version, after the update it sits next to", () => {
  const markup = headerMarkup(3, new Date(HEADER_NOW - 60_000).toISOString(), "0.1.99", undefined, BEHIND);
  assert.ok(markup.indexOf("0.1.99 available") < markup.indexOf("pw-header__build"), "the build token follows the update");
  assert.match(markup, /<span class="pw-sr">build <\/span><span class="pw-header__build">9f2c1ab<\/span>/);
  assert.match(markup, /23 behind/);
  assert.doesNotMatch(markup, /pw-header--stale/);
});

const { IssueDetail, IssuePage, LatestNote, Notes, callFor, reasonTemplate, shownOf } = await import(
  "../ui/components/IssuePage.tsx"
);

function aPreview(over: Partial<IssuePreview> = {}): IssuePreview {
  return {
    id: "sr-15s2",
    title: "Honour paid checkout?",
    status: "open",
    issueType: "decision",
    priority: 1,
    labels: ["needs-decision"],
    project: "session-replay",
    projectName: "session-replay",
    classification: "yours:decision",
    closed: false,
    staleness: {
      verdict: "still-blocking",
      checked: true,
      checkedAt: "2026-09-08T13:00:00Z",
      evidence: ["it names sr-tot5, still open"],
      unresolved: [],
    },
    ...over,
  };
}

function pageMarkup(preview?: IssuePreview): string {
  return renderToStaticMarkup(
    createElement(IssuePage, { route: { project: "session-replay", id: "sr-15s2" }, preview }),
  );
}

function notesMarkup(text?: string): string {
  return renderToStaticMarkup(
    createElement(Notes, { authority: { kind: "beads" as const, location: ".beads" }, text }),
  );
}

const FIRST_NOTE = "SPLIT: the latency half is now pitwall-463.";

const THREE_NOTES = [
  FIRST_NOTE,
  "MEASURED: the page is showing history as though it were the brief.",
  "Decide whether the count or a size is the honest summary.",
].join("\n\n");

function detailMarkup(over: Partial<IssuePayload["issue"]> = {}): string {
  const view = buildIssueView(payload(over));
  return renderToStaticMarkup(createElement(IssueDetail, { shown: shownOf(view), view }));
}

test("the notes a ticket has accumulated open behind a counted disclosure, not as a wall", () => {
  const markup = notesMarkup(THREE_NOTES);
  assert.match(markup, /<details class="pw-disclosure"/);
  assert.doesNotMatch(markup, /<details[^>]* open/, "history nobody asked for does not open itself");
  assert.match(markup, /<span class="pw-disclosure__label">3 notes<\/span>/);
  assert.match(markup, /append-only history, newest last/);
  assert.match(markup, /SPLIT: the latency half is now pitwall-463\./, "collapsed is not removed");
  assert.match(markup, /Decide whether the count or a size is the honest summary\./);
});

test("a disclosure never opens onto nothing, and one note is not '1 notes'", () => {
  assert.match(notesMarkup("Landed as site#16."), /<span class="pw-disclosure__label">1 note<\/span>/);
  const none = notesMarkup(undefined);
  assert.match(none, /<p class="pw-empty">No notes were recorded\.<\/p>/);
  assert.doesNotMatch(none, /pw-disclosure/);
  const blank = notesMarkup("\n  \n");
  assert.match(blank, /<p class="pw-empty">No notes were recorded\.<\/p>/);
  assert.doesNotMatch(blank, /pw-disclosure/);
});

test("the note quoted under the call is somebody's words, and only where somebody is being asked", () => {
  const asked = renderToStaticMarkup(
    createElement(LatestNote, { classification: "yours:decision", closed: false, notes: THREE_NOTES }),
  );
  assert.match(asked, /<p class="pw-call__ask">/);
  assert.match(asked, /<span class="pw-call__ask-label">Latest note<\/span>/);
  assert.match(
    asked,
    /<q class="pw-call__ask-text">Decide whether the count or a size is the honest summary\.<\/q>/,
  );

  const long = renderToStaticMarkup(
    createElement(LatestNote, {
      classification: "yours:access",
      closed: false,
      notes: `${"the token is still not on this machine, ".repeat(6)}end`,
    }),
  );
  const quoted = /<q class="pw-call__ask-text">([^<]*)<\/q>/.exec(long)?.[1];
  assert.ok(quoted !== undefined && quoted.length <= 120, "a citation is a line, not a paragraph");

  for (const classification of ["in-flight", "landing", "parked:tooling", "blocked"] as const) {
    assert.equal(
      renderToStaticMarkup(createElement(LatestNote, { classification, closed: false, notes: THREE_NOTES })),
      "",
      `${classification} asks nothing of the reader, so it quotes nothing at them`,
    );
  }
  assert.equal(
    renderToStaticMarkup(
      createElement(LatestNote, { classification: "yours:decision", closed: true, notes: THREE_NOTES }),
    ),
    "",
  );
  assert.equal(
    renderToStaticMarkup(createElement(LatestNote, { classification: "yours:decision", closed: false })),
    "",
  );
  assert.doesNotMatch(pageMarkup(aPreview()), /pw-call__ask/, "the snapshot carries no notes to quote");
});

test("a stamped note is quoted by what it says, with its date beside the quote and not inside it", () => {
  const stamped = renderToStaticMarkup(
    createElement(LatestNote, {
      classification: "yours:decision",
      closed: false,
      notes: `${THREE_NOTES}\n\n2026-09-10T00:41:03Z lane-devloop/pitwall-326\nDecide whether the count or a size is the honest summary.`,
    }),
  );
  const quoted = /<q class="pw-call__ask-text">([^<]*)<\/q>/.exec(stamped)?.[1];
  assert.equal(quoted, "Decide whether the count or a size is the honest summary.");
  assert.doesNotMatch(
    quoted ?? "",
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/,
    "the first thing a reader meets is somebody's words, not the machine's clock",
  );
  assert.match(
    stamped,
    /<time class="pw-call__ask-when" datetime="2026-09-10T00:41:03Z"/i,
    "the date is not dropped either - it is what tells a reader this note is the newest",
  );
  assert.doesNotMatch(
    stamped,
    /pw-call__ask-when[^>]*>[^<]*lane-devloop/,
    "the writer names a branch, and a branch name here embeds a tracker id",
  );

  const unstamped = renderToStaticMarkup(
    createElement(LatestNote, { classification: "yours:decision", closed: false, notes: THREE_NOTES }),
  );
  assert.match(unstamped, /<q class="pw-call__ask-text">/);
  assert.doesNotMatch(
    unstamped,
    /pw-call__ask-when|pw-call__ask-separator/,
    "a date not read from that block is not that block's date",
  );

  const stampOnly = renderToStaticMarkup(
    createElement(LatestNote, {
      classification: "yours:access",
      closed: false,
      notes: "The token never arrived.\n\n2026-09-10T00:41:03Z lane-devloop/pitwall-326",
    }),
  );
  assert.match(
    stampOnly,
    /<q class="pw-call__ask-text">2026-09-10T00:41:03Z lane-devloop\/pitwall-326<\/q>/,
    "a block with nothing but a stamp in it still quotes as written rather than as nothing",
  );
  assert.doesNotMatch(stampOnly, /pw-call__ask-when/, "the same instant is never printed twice");
});

test("the loaded ticket page puts the notes it fetched inside the disclosure, not down the page", () => {
  const markup = detailMarkup({ notes: THREE_NOTES });
  const opens = markup.indexOf('<details class="pw-disclosure"');
  assert.ok(opens > -1, "a loaded ticket renders the counted disclosure, not a wall of notes");
  const closes = markup.indexOf("</details>", opens);
  const recorded = markup.indexOf(FIRST_NOTE);
  assert.ok(
    recorded > opens && recorded < closes,
    "the history a reader did not ask for stays behind the control that counts it",
  );
  assert.match(markup, /<span class="pw-disclosure__label">3 notes<\/span>/);
});

test("the loaded ticket page cites the latest note between the call and the id, and only when asked", () => {
  const asked = detailMarkup({ notes: THREE_NOTES });
  const call = asked.indexOf('class="pw-call pw-call--yours"');
  const ask = asked.indexOf('class="pw-call__ask"');
  const id = asked.indexOf('class="pw-issue__id"');
  assert.ok(ask > -1, "a ticket wanting a decision cites the note the decision is about");
  assert.ok(call > -1 && call < ask, "the citation sits under the sentence, never above it");
  assert.ok(ask < id, "the token and its derivation stay below both");

  const parked = detailMarkup({
    classification: "parked:tooling",
    reason: { rule: "label", label: "parked-tooling" },
    notes: THREE_NOTES,
  });
  assert.doesNotMatch(parked, /pw-call__ask/, "nothing is wanted from the reader, so nothing is quoted");
});

test("the ticket view leads with the action, and the machinery comes under it", () => {
  const markup = pageMarkup(aPreview());
  const call = markup.indexOf("pw-call");
  const title = markup.indexOf("pw-issue__title");
  const id = markup.indexOf("pw-issue__id");
  const token = markup.indexOf("pw-reason__token");
  assert.ok(call > 0, "the page states a call to act");
  assert.ok(title < call, "the title names the thing the call is about");
  assert.ok(call < id && call < token, "the call is read before the id and the classification");
  assert.match(markup, /class="pw-call pw-call--yours">Decide this — nothing else can/);
});

test("a call is a sentence about what to do, one per classification and verdict", () => {
  assert.deepEqual(callFor("yours:decision", "still-blocking", false), {
    text: strings.issue.call.decision.standing,
    tone: "yours",
  });
  assert.deepEqual(callFor("yours:decision", "unchecked", false), {
    text: strings.issue.call.decision.standing,
    tone: "yours",
  });
  assert.deepEqual(callFor("yours:decision", "likely-stale", false), {
    text: strings.issue.call.decision.stale,
    tone: "yours",
  });
  assert.deepEqual(callFor("yours:access", "resolved", false), {
    text: strings.issue.call.access.stale,
    tone: "yours",
  });
  assert.deepEqual(callFor("yours:access", "still-blocking", false), {
    text: strings.issue.call.access.standing,
    tone: "yours",
  });
  assert.equal(callFor("parked:tooling", "unchecked", false).text, "Nothing for you — it is parked: tooling.");
  assert.equal(callFor("in-flight", "unchecked", false).text, strings.issue.call.inFlight);
  assert.equal(callFor("landing", "unchecked", false).text, strings.issue.call.landing);
  for (const verdict of ["still-blocking", "likely-stale", "resolved"] as const) {
    assert.deepEqual(
      callFor("landing", verdict, false),
      { text: strings.issue.call.landing, tone: "waiting" },
      verdict,
    );
  }
  assert.equal(callFor("ready", "unchecked", false).text, strings.issue.call.ready);
  assert.equal(callFor("blocked", "unchecked", false).text, strings.issue.call.blocked);
  assert.deepEqual(callFor("unknown", "unchecked", false), {
    text: "Nothing for you yet — its tracker could not be read, so nothing can say what holds it.",
    tone: "waiting",
  });
  assert.doesNotMatch(callFor("unknown", "unchecked", false).text, /parked|ready/);
  assert.equal(callFor(undefined, "unchecked", true).text, strings.issue.call.closed);
  assert.equal(callFor("yours:decision", "still-blocking", true).tone, "waiting");
  for (const classification of Classification.options) {
    const call = callFor(classification, "unchecked", false);
    assert.ok(call.text.length > 0, `${classification} has no call`);
    assert.equal(call.tone, isYours(classification) ? "yours" : "waiting", classification);
  }
});

const { ParkAge } = await import("../ui/components/ParkAge.tsx");
const { Parked: ParkedBand } = await import("../ui/components/Parked.tsx");
const { NeedsYou: NeedsYouBand } = await import("../ui/components/NeedsYou.tsx");

function ageMarkup(park: { since?: string; ms?: number; suspect: boolean }): string {
  return renderToStaticMarkup(createElement(ParkAge, { park }));
}

test("a park age leads with the number, flags a suspect one in words, and never invents an age it cannot place", () => {
  const unknown = ageMarkup({ suspect: false });
  assert.equal(unknown, `<span class="pw-age" title="${strings.park.unknownTitle}">—</span>`);
  const since = "2026-08-28T14:11:00Z";
  const known = ageMarkup({ since, ms: 3 * DAY + 2 * 60 * 60_000, suspect: false });
  assert.match(known, /^<span class="pw-age" title="Earliest the console can place this park: [^"]+\. The tracker does not record when the label went on\.">3d2h<\/span>$/);
  assert.doesNotMatch(known, /pw-age--suspect|not re-examined/);
  const suspect = ageMarkup({ since, ms: 11 * DAY, suspect: true });
  assert.match(suspect, /^<span class="pw-age pw-age--suspect" title="[^"]*Parked longer than 7 days and nothing has re-examined why\.">11d0h<\/span><span class="pw-age__flag">not re-examined<\/span>$/);
  assert.doesNotMatch(suspect, /pw-signal|pw-alert|pw-hold|style=/, "age is grey ink, never a signal colour");
});

test("the needs-you band shows how long each park has waited between the title and the verdict", () => {
  const board = buildBoard(AGED, {}, AGED_QUESTIONS);
  const markup = renderToStaticMarkup(createElement(NeedsYouBand, { groups: board.needsYou }));
  assert.match(markup, /<th scope="col">Title<\/th><th scope="col">Parked<\/th><th scope="col">Staleness<\/th>/);
  assert.match(markup, /<th colSpan="8" scope="rowgroup">pitwall<\/th>/);
  const old = markup.indexOf("pitwall-old");
  const mute = markup.indexOf("pitwall-mute");
  assert.ok(old > -1 && old < mute, "the oldest park is read first");
  assert.match(markup, /pitwall-old.*?<td class="pw-cell pw-cell--at"><span class="pw-age pw-age--suspect"[^>]*>11d0h<\/span><span class="pw-age__flag">not re-examined<\/span><\/td>/);
  assert.match(markup, /pitwall-mute.*?<td class="pw-cell pw-cell--kind" title="Labelled needs-decision, but no line states the question\.">misfiled<\/td>/);
  assert.match(markup, /pitwall-new.*?<td class="pw-cell pw-cell--at"><span class="pw-age" title="[^"]*next collection\.">—<\/span><\/td>/);
  assert.equal(markup.match(/>misfiled</g)?.length, 1);
  assert.doesNotMatch(markup, /pw-row--alert|pw-row--signal/, "the red rail is the band's, not a row's");
});

test("the parked band lists the suspect parks in the open and the rest behind a disclosure, never a summed count", () => {
  const board = buildBoard(AGED, {}, AGED_QUESTIONS);
  const markup = renderToStaticMarkup(
    createElement(ParkedBand, { entries: board.parked, rows: board.parkedRows }),
  );
  assert.match(markup, /^<p class="pw-parked">tooling 1 · watch 1 · umbrella 2 · roadmap 1<\/p><p class="pw-parked pw-parked--blocked">blocked 1<\/p>/);
  const suspect = markup.indexOf('<table class="pw-table pw-table--parked"><caption class="pw-sr">Parked issues past the threshold');
  const disclosure = markup.indexOf('<details class="pw-disclosure">');
  assert.ok(suspect > -1 && disclosure > suspect, "the suspect table is in the open, above the rest");
  assert.doesNotMatch(markup, /<details[^>]* open/);
  assert.match(markup, /<span class="pw-disclosure__label">Also parked, under 7d<\/span><span aria-hidden="true" class="pw-disclosure__separator"> · <\/span><span class="pw-disclosure__hint">not yet suspect; oldest first<\/span>/);
  assert.match(markup, /Parked issues under the threshold, oldest first, by project\./);
  const t1 = markup.indexOf("pitwall-t1");
  const t3 = markup.indexOf("pitwall-t3");
  const t2 = markup.indexOf("pitwall-t2");
  const t4 = markup.indexOf("pitwall-t4");
  assert.ok(t1 > suspect && t3 > t1 && t3 < disclosure, "9d before 8d, both suspect");
  assert.ok(t2 > disclosure && t4 > t2, "2d then the unknown, inside the disclosure");
  assert.match(markup, /pitwall-t1.*?<td class="pw-cell pw-cell--kind">tooling<\/td><td class="pw-cell pw-cell--title"><a class="pw-link" href="#\/issue\/pitwall\/pitwall-t1">/);
  assert.doesNotMatch(markup, /pitwall-epic|pitwall-dep/, "a structural park has nothing to re-examine");
  assert.doesNotMatch(markup, /\b5\b/, "the five parked issues are never summed");

  const quiet = renderToStaticMarkup(
    createElement(ParkedBand, {
      entries: [{ reason: "blocked", count: 2 }],
      rows: { suspect: [], rest: [] },
    }),
  );
  assert.equal(quiet, '<p class="pw-parked pw-parked--blocked">blocked 2</p>', "nothing beyond the summary when no label parks");
});

test("the call names the age once a park is suspect, and a decision with no question is told so first", () => {
  const suspect = { since: "2026-08-28T14:11:00Z", ms: 11 * DAY, suspect: true };
  const fresh = { since: "2026-09-05T14:11:00Z", ms: 3 * DAY, suspect: false };
  assert.equal(
    callFor("yours:decision", "still-blocking", false, { park: suspect }).text,
    "Decide this - it has waited 11d0h, and nothing has re-examined why.",
  );
  assert.equal(callFor("yours:decision", "still-blocking", false, { park: fresh }).text, strings.issue.call.decision.standing);
  assert.equal(
    callFor("yours:decision", "still-blocking", false, { park: suspect, misfiled: true }).text,
    strings.issue.call.decision.misfiled,
    "misfiled outranks age",
  );
  assert.equal(
    callFor("yours:decision", "likely-stale", false, { park: suspect, misfiled: true }).text,
    strings.issue.call.decision.stale,
    "an expired verdict outranks both",
  );
  assert.equal(
    callFor("yours:access", "unchecked", false, { park: suspect }).text,
    "Run this - it has waited 11d0h, and nothing has re-examined why.",
  );
  assert.deepEqual(callFor("parked:tooling", "unchecked", false, { park: suspect }), {
    text: "Read this - parked as tooling for 11d0h, and nothing has re-examined why. If the reason has expired, remove the park in the tracker.",
    tone: "yours",
  });
  assert.deepEqual(callFor("parked:tooling", "unchecked", false, { park: fresh }), {
    text: "Nothing for you — it is parked: tooling.",
    tone: "waiting",
  });
  assert.deepEqual(callFor("parked:tooling", "unchecked", false, { park: suspect, liftable: true }), {
    text: "Read this - parked as tooling for 11d0h, and nothing has re-examined why. If the reason has expired, say so below and lift the park.",
    tone: "yours",
  });
  assert.deepEqual(callFor("parked:umbrella", "unchecked", false, { park: suspect, liftable: false }), {
    text: "Read this - parked as umbrella for 11d0h, and nothing has re-examined why. If the reason has expired, remove the park in the tracker.",
    tone: "yours",
  });
  assert.equal(
    callFor("parked:tooling", "unchecked", false, { park: fresh, liftable: true }).text,
    "Nothing for you — it is parked: tooling.",
    "a fresh park is not a call to lift it",
  );
  assert.equal(callFor("blocked", "unchecked", false, { park: suspect }).text, strings.issue.call.blocked);
  assert.equal(callFor("yours:decision", "unchecked", true, { park: suspect }).text, strings.issue.call.closed);
});

test("the ticket page places the park under the classification and states the question above the latest note", () => {
  const aged = pageMarkup(
    aPreview({ park: { since: "2026-08-28T14:11:00Z", ms: 11 * DAY, suspect: true }, question: "Honour paid checkout?" }),
  );
  assert.match(aged, /class="pw-call pw-call--yours">Decide this - it has waited 11d0h/);
  assert.match(aged, /<p class="pw-call__ask"><span class="pw-call__ask-meta"><span class="pw-call__ask-label">Question<\/span><\/span><q class="pw-call__ask-text">Honour paid checkout\?<\/q><\/p>/);
  const token = aged.indexOf('<span class="pw-reason__token">yours:decision</span>');
  const age = aged.indexOf('<p class="pw-reason"><span class="pw-age pw-age--suspect"');
  assert.ok(token > -1 && age > token, "the age line follows the reason paragraph");
  assert.match(aged, /pw-age__flag">not re-examined<\/span><span class="pw-reason__because"> - earliest the console can place this park: [^<]+<\/span><\/p>/);

  const misfiled = pageMarkup(aPreview({ park: { since: "2026-09-05T14:11:00Z", ms: 3 * DAY, suspect: false } }));
  assert.match(misfiled, /pw-call--yours">This is labelled a decision, but no question is stated/);
  assert.doesNotMatch(misfiled, /pw-call__ask/);

  const unplaced = pageMarkup(aPreview({ park: { suspect: false } }));
  assert.match(unplaced, /pw-call--yours">Decide this — nothing else can/);
  assert.match(unplaced, /<p class="pw-reason"><span class="pw-age" title="[^"]+">—<\/span><span class="pw-reason__because"> - when this park went on is not yet known<\/span><\/p>/);

  const structural = pageMarkup(
    aPreview({ classification: "blocked", labels: [], staleness: { verdict: "unchecked", checked: false, evidence: [], unresolved: [] } }),
  );
  assert.doesNotMatch(structural, /pw-age/, "no label park, no age line");
  assert.doesNotMatch(pageMarkup(aPreview()), /pw-age/, "a preview with no park says nothing about one");

  const view = buildIssueView(
    payload({
      stopped: { since: "2026-08-28T14:11:00Z", basis: "carried" },
      question: "Honour paid checkout?",
      labels: ["needs-decision"],
    }, { generatedAt: GENERATED_AT, status: "open" }),
  );
  assert.equal(view.park?.ms, 11 * DAY);
  assert.equal(view.question, "Honour paid checkout?");
  const loaded = renderToStaticMarkup(createElement(IssueDetail, { shown: shownOf(view), view }));
  assert.match(loaded, /Decide this - it has waited 11d0h/);
  const question = loaded.indexOf("pw-call__ask-label\">Question");
  const latest = loaded.indexOf("pw-call__ask-label\">Latest note");
  assert.ok(question > -1);
  assert.equal(latest, -1, "the snapshot carries no notes to quote here");
});

test("a landing issue asks nothing of the reader, whatever verdict it carries", () => {
  const markup = pageMarkup(
    aPreview({
      classification: "landing",
      staleness: { verdict: "unchecked", checked: false, evidence: [], unresolved: [] },
    }),
  );
  assert.match(markup, /class="pw-call pw-call--waiting">Nothing for you/);
  assert.doesNotMatch(markup, /pull request/, "no call offers a pull request state");
  assert.match(markup, /pw-reason__token">landing</, "the classification is unchanged");
  assert.doesNotMatch(markup, /pw-call__ask/, "a landing issue still quotes no note");
});

test("a blocked sentence agrees in number with the blockers it names", () => {
  assert.equal(reasonTemplate({ rule: "blocked-open", ids: ["pitwall-a"] }), "{ids} is open");
  assert.equal(
    reasonTemplate({ rule: "blocked-open", ids: ["pitwall-a", "pitwall-b"] }),
    "{ids} are open",
  );
  assert.equal(
    reasonTemplate({ rule: "blocked-unreadable", ids: ["pitwall-a"] }),
    "{ids} could not be read",
  );
  assert.equal(
    reasonTemplate({ rule: "blocked-unreadable", ids: ["pitwall-a", "pitwall-b"] }),
    "{ids} could not be read",
  );
  const others: Array<
    Exclude<ClassificationReason, { rule: "closed" | "blocked-open" | "blocked-unreadable" }>
  > = [
    { rule: "in-progress-lane", slot: 3 },
    { rule: "in-progress-no-lane" },
    { rule: "label", label: "watch" },
    { rule: "umbrella-type", issueType: "epic" },
    { rule: "umbrella-title-marker" },
    { rule: "umbrella-open-child", childId: "pitwall-a.1" },
    { rule: "blocked-parent-in-progress", parentId: "pitwall-a" },
    { rule: "stored-status", status: "blocked" },
    { rule: "uncollected" },
    { rule: "default" },
  ];
  for (const reason of others) {
    assert.equal(reasonTemplate(reason), strings.issue.reason[reason.rule], reason.rule);
  }
});

test("a row clicked from the board paints its answer before the fetch, never a blank page", () => {
  const markup = pageMarkup(aPreview());
  assert.match(markup, /Honour paid checkout\?/);
  assert.match(markup, /it names sr-tot5, still open/);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /<p class="pw-empty" role="status">Reading the issue…<\/p>/);
  assert.doesNotMatch(markup, /band-description/);
  assert.doesNotMatch(markup, /band-notes/);
  assert.doesNotMatch(markup, /band-dependencies/);
  assert.doesNotMatch(markup, /, because /, "the reason is not in the snapshot, so nothing claims it is");
  assert.match(markup, /<span class="pw-reason__token">yours:decision<\/span>/);
});

test("a page with nothing to preview still says it is working", () => {
  const markup = pageMarkup(undefined);
  assert.match(markup, /Back to the board/);
  assert.match(markup, /<p class="pw-empty" role="status">Reading the issue…<\/p>/);
  assert.doesNotMatch(markup, /pw-issue__title/);
  assert.doesNotMatch(markup, /pw-call/);
});

test("the staleness band states its method once and never lists what it could not check", () => {
  const markup = pageMarkup(
    aPreview({
      staleness: {
        verdict: "still-blocking",
        checked: true,
        checkedAt: "2026-09-08T13:00:00Z",
        evidence: ["it names sr-tot5, still open"],
        unresolved: [{ kind: "precondition", count: 3 }],
      },
    }),
  );
  const method = "It cannot see anything outside that.";
  assert.ok(strings.issue.stale.method.endsWith(method));
  assert.equal(markup.split(method).length - 1, 1, "the method is stated once, not once per finding");
  assert.match(markup, /3 preconditions could not be run; they are recorded in the snapshot\./);
  assert.doesNotMatch(markup, /could not resolve/);

  const one = pageMarkup(
    aPreview({
      staleness: {
        verdict: "still-blocking",
        checked: true,
        evidence: ["a"],
        unresolved: [{ kind: "precondition", count: 1 }],
      },
    }),
  );
  assert.match(one, /1 precondition could not be run; it is recorded in the snapshot\./);

  const none = pageMarkup(aPreview());
  assert.doesNotMatch(none, /could not be run/);
});

test("the staleness band never claims a pull request nobody looked at", () => {
  const markup = pageMarkup(
    aPreview({
      staleness: {
        verdict: "unchecked",
        checked: false,
        evidence: [],
        unresolved: [{ kind: "precondition", count: 1 }],
      },
    }),
  );
  assert.match(markup, /1 precondition could not be run; it is recorded in the snapshot\./);
  assert.doesNotMatch(markup, /could not be checked/, "there was no reference, so none is claimed");
  assert.doesNotMatch(markup, /reference/);
  assert.doesNotMatch(strings.issue.stale.method, /pull request/);
});

test("a verdict with no evidence to act on says so rather than showing an empty list", () => {
  const markup = pageMarkup(
    aPreview({
      staleness: { verdict: "still-blocking", checked: true, evidence: [], unresolved: [] },
    }),
  );
  assert.match(markup, /Checked; nothing has changed that this check can see\./);
  assert.doesNotMatch(markup, /<ul class="pw-evidence">/);
});

test("the ticket view opens its facts with whose queue it is in, then who asked, and says unassigned in words", () => {
  const both = pageMarkup(aPreview({ owner: "pitwall-devloop", reporter: "pitwall-planning-session" }));
  assert.match(
    both,
    /<dl class="pw-facts__list"><div class="pw-facts__pair"><dt class="pw-facts__term">Queue<\/dt><dd class="pw-facts__value pw-cell--data">pitwall-devloop<\/dd><\/div><div class="pw-facts__pair"><dt class="pw-facts__term">Asked by<\/dt><dd class="pw-facts__value pw-cell--data">pitwall-planning-session<\/dd><\/div><div class="pw-facts__pair"><dt class="pw-facts__term">Project<\/dt>/,
  );
  const neither = pageMarkup(aPreview());
  assert.match(
    neither,
    /<dt class="pw-facts__term">Queue<\/dt><dd class="pw-facts__value"><span class="pw-absent">unassigned<\/span><\/dd><\/div><div class="pw-facts__pair"><dt class="pw-facts__term">Asked by<\/dt><dd class="pw-facts__value"><span class="pw-absent">not recorded<\/span><\/dd>/,
  );
  assert.equal(neither.includes("pitwall-devloop"), false, "an unassigned issue is owned by nobody in particular");
  const origin = { session: "pitwall-planning-session", ref: "843c93" };
  const view = buildIssueView(payload({ owner: "pitwall-devloop", origin }));
  const shown = shownOf(view);
  assert.equal(shown.owner, "pitwall-devloop");
  assert.equal(shown.reporter, undefined);
  const loaded = renderToStaticMarkup(createElement(IssueDetail, { shown, view, sort: "owner" }));
  assert.match(loaded, /<dt class="pw-facts__term">Session<\/dt><dd class="pw-facts__value pw-cell--data">pitwall-planning-session<\/dd>/, "the origin band is what the creator wrote about itself and stays");
  assert.match(loaded, /<dt class="pw-facts__term">Asked by<\/dt><dd class="pw-facts__value"><span class="pw-absent">not recorded<\/span>/, "origin is never stood in for the reporter");
  assert.match(loaded, /class="pw-link pw-link--back" href="#\/\?sort=owner"/, "the way back keeps the sort");
});

test("the preview a click starts from is the snapshot's own record of the issue", () => {
  const snapshot = snapshotOf([
    project("session-replay", {
      issues: [issue("sr-15s2", "yours:decision", { labels: ["needs-access"], owner: "sr-planning-session", staleness: { verdict: "still-blocking", checkedAt: "2026-09-08T13:00:00Z", evidence: ["it names sr-9, still open"] } })],
      errors: [
        { source: "staleness sr-15s2", message: "2 preconditions could not be run: `npm whoami`, `gh auth status`", at: GENERATED_AT },
        { source: "staleness sr-other", message: "1 precondition could not be run: `npm whoami`", at: GENERATED_AT },
      ],
    }),
  ]);
  const preview = previewIssue(snapshot, "session-replay", "sr-15s2");
  assert.equal(preview?.title, "title for sr-15s2");
  assert.equal(preview?.owner, "sr-planning-session");
  assert.equal(preview?.reporter, undefined);
  assert.equal(preview?.projectName, "session-replay");
  assert.equal(preview?.classification, "yours:decision");
  assert.equal(preview?.closed, false);
  assert.deepEqual(preview?.staleness.evidence, ["it names sr-9, still open"]);
  assert.deepEqual(
    preview?.staleness.unresolved,
    [{ kind: "precondition", count: 2 }],
    "only this issue's own failed checks are counted",
  );
  assert.equal(previewIssue(snapshot, "session-replay", "sr-nope"), undefined);
  assert.equal(previewIssue(snapshot, "nowhere", "sr-15s2"), undefined);
});

test("a failed check is counted under the kind its message names, and an uncounted failure adds nothing", () => {
  const view = buildIssueView({
    ...payload({ staleness: { verdict: "still-blocking", evidence: ["it names sr-9, still open"] } }),
    errors: [
      { source: "staleness sr-i6yt", message: "2 preconditions could not be run: `npm whoami`, `gh auth status`", at: GENERATED_AT },
    ],
  });
  assert.deepEqual(view.staleness.unresolved, [{ kind: "precondition", count: 2 }]);
  assert.deepEqual(view.staleness.evidence, ["it names sr-9, still open"]);

  const unnumbered = buildIssueView({
    ...payload(),
    errors: [
      {
        source: "staleness sr-i6yt",
        message: "the project records no issue id prefix, so referenced issues cannot be recognised",
        at: GENERATED_AT,
      },
    ],
  });
  assert.deepEqual(unnumbered.staleness.unresolved, [], "a failure with no leading count contributes nothing");
  assert.deepEqual(buildIssueView(payload()).staleness.unresolved, []);
});

const { Band } = await import("../ui/components/Band.tsx");
const { Filters, filterSentence } = await import("../ui/components/Filters.tsx");
const { NeedsYou } = await import("../ui/components/NeedsYou.tsx");
const { Ready } = await import("../ui/components/Ready.tsx");
const { Problems } = await import("../ui/components/Problems.tsx");

const MIXED_PROJECTS = [
  project("pitwall", {
    issues: [
      issue("pitwall-4b5", "yours:decision", { issueType: "epic", owner: "pitwall-planning-session", reporter: "pitwall-devloop" }),
      issue("pitwall-4b5.1", "yours:decision", { issueType: "bug", owner: "pitwall-devloop" }),
      issue("pitwall-4b5.2", "ready", { issueType: "task", priority: 2, owner: "pitwall-devloop", reporter: "pitwall-planning-session" }),
      issue("pitwall-7qq", "ready", { issueType: undefined, priority: undefined }),
    ],
    lanes: [
      { slot: 1, state: "working", issueId: "pitwall-4b5.2" },
      { slot: 2, state: "stranded" },
    ],
  }),
  project("session-replay", {
    issues: [issue("sr-1aa", "ready", { issueType: "chore", priority: 3, reporter: "sr-seo" })],
    errors: [{ source: "bd list --json", message: "tracker read timed out after 10s", at: "2026-09-08T14:10:00Z" }],
  }),
];

const MIXED = snapshotOf(MIXED_PROJECTS);

const FILTER_MATRIX: FilterState[] = [
  {},
  { project: "pitwall" },
  { type: "bug" },
  { type: "none" },
  { priority: "1" },
  { priority: "none" },
  { epic: "pitwall-4b5" },
  { epic: "none" },
  { owner: "pitwall-devloop" },
  { owner: "none" },
  { project: "session-replay", type: "zzz", priority: "4", epic: "nothing", owner: "nobody" },
];

function shownIds(board: Board): string[] {
  return [
    ...board.needsYou.flatMap((group) => group.rows.map((row) => row.id)),
    ...board.ready.map((row) => row.id),
  ].sort();
}

test("two failures the run recorded at one instant are still two rows a reader can tell apart", () => {
  const at = "2026-09-08T14:09:00Z";
  const board = buildBoard(
    snapshotOf([
      project("maas", {
        issues: [],
        errors: [
          {
            source: "staleness",
            message: "the project records no issue id prefix, so referenced issues cannot be recognised",
            at,
          },
          {
            source: "staleness",
            message: "no pull request host is configured, so pull requests could not be looked up",
            at,
          },
        ],
      }),
    ]),
  );
  const keys = board.problems.map((row) => problemKey(row));
  assert.equal(new Set(keys).size, board.problems.length, "a row a React list drops is a failure nobody reads");
  const markup = renderToStaticMarkup(createElement(Problems, { rows: board.problems }));
  assert.equal(markup.match(/records no issue id prefix/g)?.length, 1);
  assert.equal(markup.match(/no pull request host is configured/g)?.length, 1);
});

test("problems render whole under every filter, because a hidden collection failure reads as health", () => {
  const unfiltered = buildBoard(MIXED).problems;
  assert.equal(unfiltered.length, 1);
  for (const filter of FILTER_MATRIX) {
    const board = buildBoard(MIXED, filter);
    assert.deepEqual(board.problems, unfiltered, `problems changed under ${JSON.stringify(filter)}`);
  }
  const markup = renderToStaticMarkup(
    createElement(Band, {
      id: "problems",
      label: strings.band.problems,
      count: strings.filters.notFiltered,
      children: createElement(Problems, { rows: buildBoard(MIXED, { type: "bug" }).problems }),
    }),
  );
  assert.ok(markup.includes("bd list --json"), "the source that could not be read must survive filtering");
  assert.ok(markup.includes(strings.filters.notFiltered), "a filtered board must say problems are not filtered");
});

test("the problems table bounds its source column so a long source wraps inside it and the message keeps its width", () => {
  const source = "/Users/somebody/Documents/work/pitwall/.beads";
  assert.equal(source.length, 45);
  const board = buildBoard(
    snapshotOf([
      project("pitwall", {
        issues: [issue("pitwall-4b5.2", "ready")],
        errors: [{ source, message: "field scope origin/HEAD could not be resolved", at: "2026-09-20T09:00:00Z" }],
      }),
    ]),
  );
  const problems = renderToStaticMarkup(createElement(Problems, { rows: board.problems }));
  assert.ok(problems.includes(`<td class="pw-cell pw-cell--source">${source}</td>`));
  assert.ok(!problems.includes("pw-cell--id"), "the id cell means one line everywhere it appears");
  const ready = renderToStaticMarkup(createElement(Ready, { rows: board.ready, total: board.ready.length }));
  assert.ok(ready.includes('<td class="pw-cell pw-cell--id">pitwall-4b5.2</td>'));

  const css = readFileSync(new URL("../ui/styles/console.css", import.meta.url), "utf8");
  const phone = css.indexOf("@media (max-width: 640px)");
  assert.ok(phone > 0);
  const base = css.slice(0, phone);
  const narrow = css.slice(phone);
  const dataCells = base.match(/\.pw-cell--id,\n\.pw-cell--source,[^}]*\}/);
  assert.ok(dataCells, "the source cell shares the data-font rule with the id cell");
  assert.match(dataCells[0], /white-space: nowrap;/);
  const problemsTable = base.match(/\.pw-table--problems \{[^}]*\}/);
  assert.ok(problemsTable, "the problems table has a column template of its own");
  assert.match(problemsTable[0], /display: grid;/);
  assert.match(
    problemsTable[0],
    /grid-template-columns: auto fit-content\(28ch\) 1fr auto;/,
    "the source column is bounded and the message column takes what is left",
  );
  assert.match(
    base,
    /\.pw-table--problems \.pw-cell--source \{\n\s+white-space: normal;\n\s+overflow-wrap: anywhere;\n\}/,
    "above 640px a long source wraps inside its bounded column instead of widening it",
  );
  assert.match(narrow, /\.pw-cell--source \{\n\s+white-space: normal;\n\s+overflow-wrap: anywhere;\n\s+\}/);
  assert.match(
    narrow,
    /\.pw-table--problems,\n\s+\.pw-table--problems tbody,\n\s+\.pw-table--problems tbody > tr \{\n\s+display: block;\n\s+\}/,
    "below 640px the problems rows become blocks again, so the row padding and the rails have a box to paint on",
  );
});

test("a count under a filter says what it is counting, and an unfiltered one stays a plain number", () => {
  const crowded = snapshotOf([
    project("pitwall", { issues: Array.from({ length: 5 }, (_, i) => issue(`pitwall-${i}`, "yours:decision")) }),
    project("session-replay", { issues: Array.from({ length: 60 }, (_, i) => issue(`sr-${i}`, "yours:decision")) }),
  ]);
  const board = buildBoard(crowded, { project: "pitwall" });
  assert.equal(board.needsYouCount, 5);
  assert.equal(board.totals.needsYou, 65);
  const filtered = renderToStaticMarkup(
    createElement(Band, {
      id: "needs",
      label: strings.band.needsYou,
      count: countLabel(board.needsYouCount, board.totals.needsYou, board.filtered),
      children: createElement(NeedsYou, { groups: board.needsYou }),
    }),
  );
  assert.ok(filtered.includes("5 of 65"), "a filtered count must state the total it was taken from");
  const plain = buildBoard(crowded);
  const unfiltered = renderToStaticMarkup(
    createElement(Band, {
      id: "needs",
      label: strings.band.needsYou,
      count: countLabel(plain.needsYouCount, plain.totals.needsYou, plain.filtered),
      children: createElement(NeedsYou, { groups: plain.needsYou }),
    }),
  );
  assert.ok(unfiltered.includes(">65<"));
  assert.equal(unfiltered.includes(" of "), false, "an unfiltered count must not read as a subset");
});

test("every band count under a filter reads as a subset of the figure it came from", () => {
  const board = buildBoard(MIXED, { project: "pitwall" });
  assert.equal(countLabel(board.needsYouCount, board.totals.needsYou, board.filtered), "2 of 2");
  assert.equal(countLabel(board.readyCount, board.totals.ready, board.filtered), "2 of 3");
  assert.equal(countLabel(board.runningCount, board.totals.running, board.filtered), "2 of 2");
  assert.equal(countLabel(board.issueCount, board.totals.issues, board.filtered), "4 of 5");
});

test("an issue with no type, no priority or no epic stays reachable rather than dropped", () => {
  assert.deepEqual(shownIds(buildBoard(MIXED, { type: "none" })), ["pitwall-7qq"]);
  assert.deepEqual(shownIds(buildBoard(MIXED, { priority: "none" })), ["pitwall-7qq"]);
  assert.deepEqual(shownIds(buildBoard(MIXED, { epic: "none" })), ["pitwall-4b5", "pitwall-7qq", "sr-1aa"]);
  assert.deepEqual(shownIds(buildBoard(MIXED, { epic: "pitwall-4b5" })), ["pitwall-4b5.1", "pitwall-4b5.2"]);
});

test("a lane is filtered by the issue it claims, and an unclaimed lane counts as none of them", () => {
  assert.equal(buildBoard(MIXED, { type: "task" }).runningCount, 1);
  assert.equal(buildBoard(MIXED, { type: "bug" }).runningCount, 0);
  assert.equal(buildBoard(MIXED, { type: "none" }).runningCount, 1);
  assert.equal(buildBoard(MIXED).runningCount, 2);
});

test("the board filters by queue, and an issue with no queue is reachable as unassigned rather than owned by anyone", () => {
  assert.deepEqual(shownIds(buildBoard(MIXED, { owner: "pitwall-devloop" })), ["pitwall-4b5.1", "pitwall-4b5.2"]);
  assert.deepEqual(shownIds(buildBoard(MIXED, { owner: "pitwall-planning-session" })), ["pitwall-4b5"]);
  assert.deepEqual(shownIds(buildBoard(MIXED, { owner: "none" })), ["pitwall-7qq", "sr-1aa"]);
  assert.deepEqual(shownIds(buildBoard(MIXED, { owner: "sr-seo" })), [], "a reporter is not a queue");
  const board = buildBoard(MIXED, { owner: "none" });
  assert.equal(board.filtered, true);
  assert.equal(board.issueCount, 2);
  assert.deepEqual(
    board.options.owner.map((option) => option.value),
    ["pitwall-devloop", "pitwall-planning-session"],
    "the queue options are the distinct queues in the snapshot, sorted, and nothing stands in for absent",
  );
});

test("a lane whose issue cannot be resolved matches the unassigned queue and no named one", () => {
  assert.equal(buildBoard(MIXED, { owner: "pitwall-devloop" }).runningCount, 1);
  assert.equal(buildBoard(MIXED, { owner: "pitwall-planning-session" }).runningCount, 0);
  assert.equal(buildBoard(MIXED, { owner: "none" }).runningCount, 1);
});

const SORTED_PROJECTS = [
  project("pitwall", {
    issues: [
      issue("pitwall-1", "yours:decision", { labels: ["needs-decision"], priority: 0 }),
      issue("pitwall-2", "yours:decision", { labels: ["needs-decision"], priority: 1, owner: "pitwall-planning-session", reporter: "pitwall-devloop" }),
      issue("pitwall-3", "yours:access", { labels: ["needs-access"], priority: 2, owner: "pitwall-devloop" }),
      issue("pitwall-4", "yours:decision", { labels: ["needs-decision"], priority: 3, owner: "pitwall-blogging", reporter: "pitwall-planning-session" }),
      issue("pitwall-5", "ready", { priority: 0 }),
      issue("pitwall-6", "ready", { priority: 1, owner: "pitwall-devloop", reporter: "pitwall-planning-session" }),
      issue("pitwall-7", "ready", { priority: 2, owner: "pitwall-blogging", reporter: "pitwall-seo" }),
      issue("pitwall-8", "parked:watch", { labels: ["watch"], priority: 0, reporter: "pitwall-seo" }),
      issue("pitwall-9", "parked:watch", { labels: ["watch"], priority: 1, owner: "pitwall-planning-session" }),
      issue("pitwall-10", "parked:roadmap", { labels: ["roadmap"], priority: 2, owner: "pitwall-devloop", reporter: "pitwall-devloop" }),
    ],
  }),
  project("session-replay", {
    issues: [
      issue("sr-1", "ready", { priority: 0, owner: "sr-devloop" }),
      issue("sr-2", "ready", { priority: 1 }),
    ],
  }),
];

const SORTED = snapshotOf(SORTED_PROJECTS);

function rowsOf(groups: Array<{ rows: Array<{ id: string }> }>): string[][] {
  return groups.map((group) => group.rows.map((row) => row.id));
}

test("sorting by queue orders each project's rows by queue name, with the unassigned rows last as their own group", () => {
  const board = buildBoard(SORTED, {}, {}, "owner");
  assert.equal(board.sort, "owner");
  assert.deepEqual(rowsOf(board.needsYou), [["pitwall-4", "pitwall-3", "pitwall-2", "pitwall-1"]]);
  assert.deepEqual(
    board.ready.map((row) => row.id),
    ["pitwall-7", "pitwall-6", "pitwall-5", "sr-1", "sr-2"],
    "projects keep their count-then-name order; the sort runs inside each",
  );
  assert.deepEqual(rowsOf(board.parkedRows.rest), [["pitwall-10", "pitwall-9", "pitwall-8"]]);
  assert.deepEqual(rowsOf(buildBoard(SORTED).needsYou), [["pitwall-1", "pitwall-2", "pitwall-3", "pitwall-4"]]);
});

test("sorting by reporter likewise groups the rows nobody is recorded as asking for last", () => {
  const board = buildBoard(SORTED, {}, {}, "reporter");
  assert.deepEqual(rowsOf(board.needsYou), [["pitwall-2", "pitwall-4", "pitwall-1", "pitwall-3"]]);
  assert.deepEqual(board.ready.map((row) => row.id), ["pitwall-6", "pitwall-7", "pitwall-5", "sr-1", "sr-2"]);
  assert.deepEqual(rowsOf(board.parkedRows.rest), [["pitwall-10", "pitwall-8", "pitwall-9"]]);
});

test("a sort is not a filter: the counts, the filtered flag and the view stay whole", () => {
  const plain = buildBoard(SORTED);
  for (const sort of ["owner", "reporter"] as const) {
    const sorted = buildBoard(SORTED, {}, {}, sort);
    assert.equal(sorted.filtered, false, sort);
    assert.equal(sorted.issueCount, plain.issueCount);
    assert.equal(sorted.readyCount, plain.readyCount);
    assert.equal(sorted.needsYouCount, plain.needsYouCount);
    assert.deepEqual(sorted.totals, plain.totals);
  }
  const both = buildBoard(SORTED, { project: "pitwall" }, {}, "owner");
  assert.equal(both.filtered, true);
  assert.deepEqual(both.ready.map((row) => row.id), ["pitwall-7", "pitwall-6", "pitwall-5"]);
});

test("the sort survives the hash, with and without filters, and an unknown sort falls back to the default", () => {
  assert.equal(boardHref({}, "owner"), "#/?sort=owner");
  assert.equal(boardHref({ project: "pitwall" }, "reporter"), "#/?project=pitwall&sort=reporter");
  assert.equal(issueHref("pitwall", "pitwall-1", { owner: "none" }, "owner"), "#/issue/pitwall/pitwall-1?owner=none&sort=owner");
  assert.equal(sortOf("#/?sort=owner"), "owner");
  assert.equal(sortOf("#/issue/pitwall/pitwall-1?project=pitwall&sort=reporter"), "reporter");
  assert.equal(sortOf("#/?project=pitwall"), undefined);
  assert.equal(sortOf("#/?sort=zzz"), undefined);
  assert.deepEqual(filterOf("#/?sort=owner"), {}, "a sort alone is no filter");
  assert.deepEqual(filterOf("#/?owner=none&sort=owner"), { owner: "none" });
  assert.deepEqual(filterOf(filterQuery({ owner: "pitwall-devloop" }, "reporter")), { owner: "pitwall-devloop" });
});

test("the sort control sits last, says default rather than priority, and keeps the filters it is beside", () => {
  const board = buildBoard(SORTED, { project: "pitwall" }, {}, "reporter");
  const markup = renderToStaticMarkup(
    createElement(Filters, {
      filter: board.filter,
      sort: board.sort,
      options: board.options,
      shown: board.issueCount,
      total: board.totals.issues,
    }),
  );
  const owner = markup.indexOf('id="filter-owner"');
  const clear = markup.indexOf(strings.filters.clear);
  const sort = markup.indexOf('id="board-sort"');
  assert.ok(owner > markup.indexOf('id="filter-epic"'), "queue follows epic");
  assert.ok(clear > owner && sort > clear, "the sort control follows the clear link");
  assert.match(markup, /<option value="">default<\/option><option value="owner">queue<\/option><option value="reporter" selected="">asked by<\/option>/);
  assert.match(markup, /href="#\/\?sort=reporter">Clear filters/, "clearing the filters keeps the sort");
  assert.equal(markup.includes("Filtered: sort"), false, "a sort states itself in the control, never as a filter");
  assert.match(
    markup,
    /<select class="pw-select" id="filter-owner"[^>]*><option value=""[^>]*>All<\/option><option value="pitwall-blogging">pitwall-blogging<\/option><option value="pitwall-devloop">pitwall-devloop<\/option><option value="pitwall-planning-session">pitwall-planning-session<\/option><option value="sr-devloop">sr-devloop<\/option><option value="none">unassigned<\/option><\/select>/,
  );
  const unassigned = buildBoard(SORTED, { owner: "none" });
  const stated = textOf(
    renderToStaticMarkup(
      createElement(Filters, {
        filter: unassigned.filter,
        options: unassigned.options,
        shown: unassigned.issueCount,
        total: unassigned.totals.issues,
      }),
    ),
  );
  assert.ok(stated.includes("Filtered: unassigned — 4 of 12 issues."), stated);
  const named = buildBoard(SORTED, { owner: "pitwall-devloop" });
  assert.equal(filterSentence(named.filter, named.options), "No issue matches queue pitwall-devloop.");
});

test("every issue row shows whose queue it is in and who asked, and absent reads as absent in words", () => {
  const board = buildBoard(SORTED, {}, {}, "owner");
  const needs = renderToStaticMarkup(createElement(NeedsYou, { groups: board.needsYou, sort: board.sort }));
  assert.match(needs, /<th scope="col">Priority<\/th><th scope="col">Queue<\/th><th scope="col">Asked by<\/th><th scope="col">Kind<\/th>/);
  assert.match(needs, /pitwall-2<\/td><td class="pw-cell pw-cell--data">P1<\/td><td class="pw-cell pw-cell--data pw-cell--who" title="pitwall-planning-session">pitwall-planning-session<\/td><td class="pw-cell pw-cell--data pw-cell--who" title="pitwall-devloop">pitwall-devloop<\/td><td class="pw-cell pw-cell--kind">decision<\/td>/);
  assert.match(needs, /pitwall-1<\/td><td class="pw-cell pw-cell--data">P0<\/td><td class="pw-cell pw-cell--who"><span class="pw-absent">unassigned<\/span><\/td><td class="pw-cell pw-cell--who"><span class="pw-absent">not recorded<\/span><\/td>/);
  assert.match(needs, /href="#\/issue\/pitwall\/pitwall-1\?sort=owner"/, "opening a ticket keeps the sort");
  assert.doesNotMatch(needs, /pw-row--signal|pw-row--alert|pw-row--hold|pw-chip/, "a queue name is not a signal");
  const ready = renderToStaticMarkup(createElement(Ready, { rows: board.ready, total: board.readyCount, sort: board.sort }));
  assert.match(ready, /<th scope="col">Priority<\/th><th scope="col">Queue<\/th><th scope="col">Asked by<\/th><th scope="col">Title<\/th>/);
  assert.match(ready, /pitwall-5<\/td><td class="pw-cell pw-cell--data">P0<\/td><td class="pw-cell pw-cell--who"><span class="pw-absent">unassigned<\/span><\/td><td class="pw-cell pw-cell--who"><span class="pw-absent">not recorded<\/span><\/td><td class="pw-cell pw-cell--title">/);
  const parked = renderToStaticMarkup(createElement(ParkedBand, { entries: board.parked, rows: board.parkedRows, sort: board.sort }));
  assert.match(parked, /<th scope="col">Priority<\/th><th scope="col">Queue<\/th><th scope="col">Asked by<\/th><th scope="col">Kind<\/th>/);
  assert.match(parked, /<th colSpan="8" scope="rowgroup">pitwall<\/th>/);
  assert.match(parked, /pitwall-9<\/td><td class="pw-cell pw-cell--data">P1<\/td><td class="pw-cell pw-cell--data pw-cell--who" title="pitwall-planning-session">pitwall-planning-session<\/td><td class="pw-cell pw-cell--who"><span class="pw-absent">not recorded<\/span><\/td>/);
});

test("an empty result names the filters that emptied it", () => {
  const filter: FilterState = { project: "pitwall", type: "bug", priority: "4", epic: "pitwall-4b5" };
  const board = buildBoard(MIXED, filter);
  assert.deepEqual(board.needsYou, []);
  const sentence = filterSentence(filter, board.options);
  const markup = renderToStaticMarkup(
    createElement(NeedsYou, { groups: board.needsYou, filteredEmpty: sentence }),
  );
  for (const part of ["project pitwall", "type bug", "P4", "epic pitwall-4b5"]) {
    assert.ok(markup.includes(part), `the empty sentence must name ${part}`);
  }
  assert.equal(
    markup.includes(strings.empty.needsYou),
    false,
    "a filtered empty band must not claim the whole band is empty",
  );
  const genuinely = buildBoard(snapshotOf([project("pitwall")]));
  assert.ok(
    renderToStaticMarkup(createElement(NeedsYou, { groups: genuinely.needsYou })).includes(strings.empty.needsYou),
  );
});

test("a filter survives the URL it is sent in, unknown values included", () => {
  const cases: FilterState[] = [
    {},
    { project: "pitwall" },
    { project: "a project", type: "bug", priority: "1", epic: "pitwall-4b5" },
    { type: "zzz" },
    { epic: "none" },
  ];
  for (const filter of cases) {
    assert.deepEqual(filterOf(filterQuery(filter)), filter);
  }
  assert.equal(boardHref({}), "#/");
  assert.equal(boardHref({ project: "pitwall" }), "#/?project=pitwall");
  assert.equal(issueHref("pitwall", "pitwall-4b5.1", { type: "bug" }), "#/issue/pitwall/pitwall-4b5.1?type=bug");
  assert.deepEqual(routeOf("#/issue/pitwall/pitwall-4b5.1?project=pitwall"), {
    project: "pitwall",
    id: "pitwall-4b5.1",
  });
  assert.deepEqual(filterOf("#/issue/pitwall/pitwall-4b5.1?project=pitwall"), { project: "pitwall" });
  assert.deepEqual(filterOf("#/?type=bug&type=task"), { type: "bug" });
  const unknown = buildBoard(MIXED, { type: "zzz" });
  assert.equal(unknown.filtered, true, "an unknown value is a live filter, not a dropped one");
  assert.equal(unknown.issueCount, 0);
});

test("the filters on screen state themselves without anything being opened", () => {
  const board = buildBoard(MIXED, { project: "pitwall", type: "zzz" });
  const markup = renderToStaticMarkup(
    createElement(Filters, {
      filter: board.filter,
      options: board.options,
      shown: board.issueCount,
      total: board.totals.issues,
    }),
  );
  assert.ok(markup.includes('id="filter-project"'));
  assert.ok(markup.includes('id="filter-epic"'));
  assert.ok(/<option value="zzz"[^>]*selected/.test(markup), "an unknown value must stay selected and visible");
  assert.ok(markup.includes(strings.filters.active));
  assert.ok(markup.includes("0 of 5 issues"));
  assert.ok(markup.includes(strings.filters.clear));
  const plain = buildBoard(MIXED);
  const bare = renderToStaticMarkup(
    createElement(Filters, {
      filter: plain.filter,
      options: plain.options,
      shown: plain.issueCount,
      total: plain.totals.issues,
    }),
  );
  assert.equal(bare.includes(strings.filters.active), false);
  assert.equal(bare.includes(strings.filters.clear), false);
});

test("filtering is a view over the snapshot and never a change to it", () => {
  const read = snapshotOf(MIXED_PROJECTS);
  const pristine = snapshotOf(MIXED_PROJECTS);
  for (const filter of FILTER_MATRIX) {
    buildBoard(read, filter);
  }
  assert.deepEqual(read, pristine, "a filter must not touch the document the console was given");
  assert.equal(buildBoard(read, { project: "pitwall" }).projectCount, 2, "the header counts the snapshot, not the view");
});

const { Parked } = await import("../ui/components/Parked.tsx");
const { Running, runningSummary } = await import("../ui/components/Running.tsx");

function parkedIssues(reason: string, count: number, bugs: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) =>
    issue(`pw-${reason.replace(":", "-")}-${index}`, reason, { issueType: index < bugs ? "bug" : "task" }),
  );
}

const PARKED_MIX = snapshotOf([
  project("pitwall", {
    issues: [
      ...parkedIssues("parked:tooling", 3, 1),
      ...parkedIssues("parked:watch", 2, 1),
      ...parkedIssues("parked:umbrella", 4, 0),
      ...parkedIssues("parked:roadmap", 6, 2),
      ...parkedIssues("blocked", 5, 0),
    ],
  }),
]);

function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

function parkedMarkup(board: Board): string {
  return renderToStaticMarkup(
    createElement(Band, {
      id: "parked",
      label: strings.band.parked,
      children: createElement(Parked, {
        entries: board.parked,
        totals: board.filtered ? board.totals.parked : undefined,
        filteredEmpty: board.filtered ? filterSentence(board.filter, board.options) : undefined,
      }),
    }),
  );
}

test("a parked reason under a filter counts itself, and the reasons are still never summed", () => {
  const plain = buildBoard(PARKED_MIX);
  assert.equal(parkedSummary(plain.parked), "tooling 3 · watch 2 · umbrella 4 · roadmap 6");
  assert.equal(blockedSummary(plain.parked), "blocked 5");

  const board = buildBoard(PARKED_MIX, { type: "bug" });
  assert.equal(
    parkedSummary(board.parked, board.totals.parked),
    "tooling 1 of 3 · watch 1 of 2 · umbrella 0 of 4 · roadmap 2 of 6",
    "a reason that filters away must still say what it filtered out",
  );
  assert.equal(blockedSummary(board.parked, board.totals.parked), "blocked 0 of 5");
  assert.equal(
    parkedSummary(board.parked, board.totals.parked).includes("blocked"),
    false,
    "blocked must not be joined into the parked reasons under a filter either",
  );

  const markup = parkedMarkup(board);
  const read = textOf(markup);
  assert.equal(markup.includes("pw-band__count"), false, "parked must carry no head count, filtered or not");
  assert.equal(read.includes("20"), false, "a summed parked figure must never be rendered");
  assert.ok(read.includes("tooling 1 of 3 · watch 1 of 2 · umbrella 0 of 4 · roadmap 2 of 6"));
  assert.ok(read.includes("blocked 0 of 5"), "a reason with nothing left must render as none of its total");
  assert.ok(markup.includes("pw-of"), "the total a count came from must read as the quieter half");

  const bare = parkedMarkup(plain);
  assert.equal(bare.includes("pw-of"), false);
  assert.equal(bare.includes(" of "), false, "an unfiltered parked band must read exactly as it always has");
  assert.ok(bare.includes("tooling 3"));
  assert.ok(bare.includes("blocked 5"));
});

test("a parked band emptied by a filter says which filter emptied it", () => {
  const board = buildBoard(PARKED_MIX, { type: "zzz" });
  assert.deepEqual(board.parked, []);
  const markup = parkedMarkup(board);
  assert.ok(markup.includes("type zzz"), "the sentence must name the filter that emptied the band");
  assert.equal(markup.includes(strings.empty.parked), false, "a filtered band must not claim nothing is parked");
  assert.equal(markup.includes(" of "), false);
});

const RUNNING_MIX = snapshotOf([
  project("maas", {
    issues: [
      issue("maas-1", "in-flight", { issueType: "bug" }),
      issue("maas-2", "in-flight", { issueType: "bug" }),
      issue("maas-3", "in-flight", { issueType: "task" }),
      issue("maas-4", "landing", { issueType: "task" }),
    ],
  }),
]);

test("a running state a filter emptied still reports the work it left outside the view", () => {
  const plain = buildBoard(RUNNING_MIX);
  assert.equal(runningSummary(plain.runningTotals), "3 working · 1 awaiting lander");

  const board = buildBoard(RUNNING_MIX, { type: "bug" });
  assert.equal(
    runningSummary(board.runningTotals, board.totals.runningStates),
    "2 of 3 working · 0 of 1 awaiting lander",
    "a state with unfiltered work must stay on the head even when the filter empties it",
  );

  const markup = renderToStaticMarkup(createElement(Running, { rows: board.running }));
  assert.ok(textOf(markup).includes("2 of 3 working"), "a running row under a filter must say what it is counting");
  assert.ok(markup.includes("pw-of"));
  const bare = renderToStaticMarkup(createElement(Running, { rows: plain.running }));
  assert.equal(bare.includes(" of "), false, "an unfiltered running row stays a plain count");
});

test("no filter control is ever disabled, because a control that cannot be used cannot explain itself", () => {
  const board = buildBoard(snapshotOf([project("pitwall", { issues: [issue("pitwall-1", "ready")] })]));
  const markup = renderToStaticMarkup(
    createElement(Filters, {
      filter: board.filter,
      options: board.options,
      shown: board.issueCount,
      total: board.totals.issues,
    }),
  );
  assert.equal(markup.includes("disabled"), false);
  assert.equal((markup.match(/<select/g) ?? []).length, 6);
});

test("a filter value the snapshot never knew says so where it is chosen and where it is stated", () => {
  const board = buildBoard(MIXED, { type: "zzz" });
  const markup = renderToStaticMarkup(
    createElement(Filters, {
      filter: board.filter,
      options: board.options,
      shown: board.issueCount,
      total: board.totals.issues,
    }),
  );
  const named = "zzz — not in this snapshot";
  assert.ok(/<option value="zzz"[^>]*selected/.test(markup), "an unknown value must stay selected");
  assert.ok(textOf(markup).includes(named), "an unknown value must name itself where it is chosen");
  assert.ok(textOf(markup).includes(`type ${named}`), "the stated filter must name it as one the snapshot has not");
  assert.ok(markup.includes("0 of 5 issues"));
});

const { Today } = await import("../ui/components/Today.tsx");

function metricsBoard(metrics: Array<Record<string, unknown>>, filter: FilterState = {}): Board {
  return buildBoard(
    snapshotOf(
      metrics.map((entry, index) =>
        project(`p${index}`, { metrics: entry, issues: [issue(`p${index}-1`, "ready")] }),
      ),
    ),
    filter,
  );
}

function todayMarkup(board: Board): string {
  return renderToStaticMarkup(
    createElement(Band, {
      id: "today",
      label: strings.band.today,
      count: board.filtered ? strings.filters.notFiltered : undefined,
      children: createElement(Today, { today: board.today }),
    }),
  );
}

test("the day's landed figure is summed only where every project computed one", () => {
  assert.deepEqual(
    metricsBoard([
      { landedToday: 9, closedToday: 13 },
      { landedToday: 4, closedToday: 6 },
    ]).today,
    { landed: 13, closed: 19 },
  );
  assert.deepEqual(
    metricsBoard([{ landedToday: 9, closedToday: 13 }, { closedToday: 6 }]).today,
    { landed: undefined, closed: 19 },
    "a partial sum presented as the day's total is the lie this field exists to stop",
  );
  assert.deepEqual(buildBoard(snapshotOf([])).today, { landed: undefined, closed: 0 });
});

test("a measured zero landed reads as a zero, and an uncomputed one reads as unknown", () => {
  const measured = textOf(todayMarkup(metricsBoard([{ landedToday: 0, closedToday: 19 }])));
  assert.ok(measured.includes("landed 0"), "nothing merged is a reading and renders as one");
  assert.ok(measured.includes("closed 19"));
  assert.equal(measured.includes(strings.today.unknown), false);

  const markup = todayMarkup(metricsBoard([{ closedToday: 19 }]));
  const read = textOf(markup);
  assert.ok(read.includes("landed unknown"));
  assert.ok(read.includes("closed 19"), "the figure that was computed still reads as a figure");
  assert.equal(read.includes("landed 0"), false, "an uncomputed figure must never read as a measured zero");
  assert.equal(read.includes(`landed ${strings.issue.facts.none}`), false);
  assert.ok(markup.includes("pw-today__unknown"), "unknown is marked so it reads as quieter than a count");
  assert.ok(read.includes(strings.today.unknownNotice), "a reader who cannot see the italics is told in words");
  assert.equal(markup.includes("pw-band--alert"), false, "throughput is not a signal and never paints like one");
});

test("metrics are per project, so a filtered today band says it is not filtered rather than narrowing", () => {
  const board = metricsBoard(
    [
      { landedToday: 9, closedToday: 13 },
      { landedToday: 4, closedToday: 6 },
    ],
    { type: "bug" },
  );
  assert.deepEqual(board.today, { landed: 13, closed: 19 });
  assert.ok(todayMarkup(board).includes(strings.filters.notFiltered));
});

const { IssueActions } = await import("../ui/components/IssueActions.tsx");

const ACTING_ROUTE = { project: "session-replay", id: "sr-15s2" };

function actionsMarkup(over: Partial<IssuePreview> = {}, loaded = true): string {
  return renderToStaticMarkup(
    createElement(IssueActions, {
      route: ACTING_ROUTE,
      shown: aPreview(over),
      loaded,
      onOutcome: () => Promise.resolve(),
    }),
  );
}

function actingDetailMarkup(over: Partial<IssuePayload["issue"]> = {}): string {
  const view = buildIssueView(payload(over));
  return renderToStaticMarkup(
    createElement(IssueDetail, {
      shown: shownOf(view),
      view,
      route: ACTING_ROUTE,
      onOutcome: () => Promise.resolve(),
    }),
  );
}

test("an issue in the owner's own queue, or parked by a label the owner can lift, offers something to do; structural parks and blocks offer nothing", () => {
  assert.match(actionsMarkup(), /<section class="pw-actions"/);
  assert.match(actionsMarkup({ classification: "yours:access" }), /<section class="pw-actions"/);
  for (const classification of ["ready", "in-flight", "landing", "blocked", "parked:roadmap"] as const) {
    assert.equal(
      actionsMarkup({ classification }),
      "",
      `${classification} is nobody's queue, so the screen offers no control on it`,
    );
  }
  assert.equal(actionsMarkup({ closed: true }), "", "a closed issue is not a queue either");
  assert.equal(
    actionsMarkup({ classification: undefined }),
    "",
    "an unclassified issue is not acted on, and reading one must not throw",
  );

  const watched = actionsMarkup({ classification: "parked:watch", labels: ["watch"] });
  assert.match(watched, /<section class="pw-actions"/);
  assert.equal(watched.match(/class="pw-button"/g)?.length, 1, "one control: lift the label, nothing else");
  assert.ok(watched.includes("Lift watch"), "the button names the label it lifts");
  for (const label of [strings.actions.answer, strings.actions.ready, strings.actions.notMine]) {
    assert.ok(!watched.includes(label), `${label} is the owner's queue, not a park`);
  }
  assert.doesNotMatch(watched, /<textarea/, "the reason box opens on request, never pre-opened");
  assert.match(watched, /aria-expanded="false"/);
  assert.ok(watched.includes(strings.actions.scope));
  assert.equal(
    actionsMarkup({ classification: "parked:roadmap", labels: [] }),
    "",
    "a park with no label on the issue has nothing the console can lift",
  );
  assert.equal(
    actionsMarkup({ classification: "parked:umbrella", labels: ["umbrella"] }),
    "",
    "an umbrella is not lifted from the console, labelled or not",
  );
  assert.equal(actionsMarkup({ classification: "blocked", labels: ["watch"] }), "", "blocked carries no label to remove");
});

test("an aged park the console can lift says so in the call, and the control sits under it", () => {
  const markup = renderToStaticMarkup(
    createElement(IssueDetail, {
      shown: aPreview({
        classification: "parked:tooling",
        labels: ["blocked-tooling"],
        park: { since: "2026-08-28T14:11:00Z", ms: 11 * DAY, suspect: true },
      }),
      route: ACTING_ROUTE,
      onOutcome: () => Promise.resolve(),
    }),
  );
  assert.match(markup, /class="pw-call pw-call--yours">Read this - parked as tooling for 11d0h,[^<]*say so below and lift the park\./);
  const call = markup.indexOf('class="pw-call ');
  const actions = markup.indexOf('<section class="pw-actions"');
  const id = markup.indexOf('class="pw-issue__id"');
  assert.ok(call > -1 && actions > -1 && id > -1);
  assert.ok(call < actions && actions < id, "the control answers the call above it");
  assert.ok(markup.includes("Lift blocked-tooling"));
  assert.doesNotMatch(markup, /remove the park in the tracker/, "the page no longer sends the reader elsewhere");

  const umbrella = renderToStaticMarkup(
    createElement(IssueDetail, {
      shown: aPreview({
        classification: "parked:umbrella",
        labels: ["umbrella"],
        park: { since: "2026-08-28T14:11:00Z", ms: 11 * DAY, suspect: true },
      }),
      route: ACTING_ROUTE,
      onOutcome: () => Promise.resolve(),
    }),
  );
  assert.match(umbrella, /remove the park in the tracker\./, "an umbrella is still lifted in the tracker");
  assert.doesNotMatch(umbrella, /<section class="pw-actions"/);
});

test("a ticket parked on a question arrives with the box open; one parked on access does not", () => {
  const asked = actionsMarkup();
  assert.match(asked, /<textarea[^>]*id="pw-action-text"/);
  assert.match(asked, /aria-expanded="true"[^>]*aria-controls="pw-action-panel"/);
  assert.ok(asked.includes(strings.actions.answerLabel));
  assert.ok(asked.includes(strings.actions.answerHint));

  const access = actionsMarkup({ classification: "yours:access" });
  assert.doesNotMatch(access, /<textarea/, "the call there is to run it, not to type an answer");
  assert.doesNotMatch(access, /aria-expanded="true"/);
  for (const label of [strings.actions.answer, strings.actions.ready, strings.actions.notMine]) {
    assert.ok(access.includes(label), `${label} is offered whatever parks the issue`);
  }
});

test("nothing can be written until the issue itself has been read", () => {
  const waiting = actionsMarkup({}, false);
  assert.equal(
    waiting.match(/<button[^>]*disabled/g)?.length,
    4,
    "a control enabled against the stale snapshot writes against data nobody has seen",
  );
  assert.ok(waiting.includes(strings.actions.waiting));
  assert.match(actionsMarkup(), /<button type="submit"[^>]*disabled/, "an empty box cannot unpark a ticket");
});

test("the controls are grey, name the tracker as their whole reach, and never say dispatch", () => {
  const markup = actionsMarkup();
  assert.equal(markup.match(/class="pw-button"/g)?.length, 4);
  assert.doesNotMatch(
    markup,
    /pw-signal|pw-alert|pw-hold|pw-row--|pw-band--alert/,
    "a button is neither a lane running nor a lane needing a person",
  );
  assert.doesNotMatch(markup, /style=/, "appearance belongs in the stylesheet");
  assert.ok(markup.includes(strings.actions.scope));
  assert.doesNotMatch(markup, /[Dd]ispatch/, "the console clears a hold; the loop decides what to run");
  assert.ok(markup.includes(strings.actions.ready));
});

test("the controls sit under the note being answered, not above it", () => {
  const markup = actingDetailMarkup({ notes: THREE_NOTES });
  const ask = markup.indexOf('class="pw-call__ask"');
  const actions = markup.indexOf('<section class="pw-actions"');
  const id = markup.indexOf('class="pw-issue__id"');
  assert.ok(ask > -1 && actions > -1 && id > -1);
  assert.ok(
    ask < actions && actions < id,
    "a box above the question is a box filled in blind",
  );
});

test("a page with nothing to act on renders exactly as it did before", () => {
  for (const over of [
    { classification: "ready" as const },
    { classification: "parked:roadmap" as const, labels: [], reason: { rule: "stored-status" as const, status: "deferred" } },
    { classification: "parked:umbrella" as const, labels: ["umbrella"], reason: { rule: "label" as const, label: "umbrella" } },
  ]) {
    const view = buildIssueView(payload(over));
    assert.equal(
      renderToStaticMarkup(
        createElement(IssueDetail, {
          shown: shownOf(view),
          view,
          route: ACTING_ROUTE,
          onOutcome: () => Promise.resolve(),
        }),
      ),
      renderToStaticMarkup(createElement(IssueDetail, { shown: shownOf(view), view })),
      `${over.classification} with labels ${JSON.stringify(over.labels ?? [])} gains nothing`,
    );
  }
});
