import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Classification, SCHEMA_VERSION, isYours, parseSnapshot } from "@404sl/pitwall-schema";
import {
  SNAPSHOT_STALE_AFTER_MS,
  blockedSummary,
  buildBoard,
  buildIssueView,
  parkedReasons,
  parkedSummary,
  previewIssue,
  snapshotAge,
} from "../ui/model.ts";
import type { IssuePayload, IssuePreview } from "../ui/model.ts";
import { strings } from "../ui/strings.ts";
import { issueHref, routeOf } from "../ui/routes.ts";
import { VERSION } from "../src/version.ts";

register("./support/svg-stub.mjs", import.meta.url);
const { Header } = await import("../ui/components/Header.tsx");

const GENERATED_AT = "2026-09-08T14:11:00Z";
const HEADER_NOW = Date.parse("2026-09-08T14:49:00Z");
const RUNNING_VERSION = VERSION.replace(/\./g, "\\.");

function headerMarkup(projectCount: number, generatedAt: string, update?: string): string {
  const realNow = Date.now;
  Date.now = () => HEADER_NOW;
  try {
    return renderToStaticMarkup(createElement(Header, { projectCount, generatedAt, version: VERSION, update }));
  } finally {
    Date.now = realNow;
  }
}

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
  assert.equal(parked.length, 4);
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
  assert.deepEqual(parkedReasons(), [...fromContract, "blocked"]);
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

test("a header rendered from a stamp it cannot read shows the stamp and claims nothing about it", () => {
  const markup = headerMarkup(1, "not-a-date");
  assert.match(markup, /1 project · /);
  assert.match(markup, /<span class="pw-header__age">not-a-date<\/span>/);
  assert.doesNotMatch(markup, /pw-header--stale/);
  assert.doesNotMatch(markup, /<time/);
});

const { IssuePage, callFor } = await import("../ui/components/IssuePage.tsx");

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
      unresolved: 0,
    },
    ...over,
  };
}

function pageMarkup(preview?: IssuePreview): string {
  return renderToStaticMarkup(
    createElement(IssuePage, { route: { project: "session-replay", id: "sr-15s2" }, preview }),
  );
}

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
  assert.equal(callFor("ready", "unchecked", false).text, strings.issue.call.ready);
  assert.equal(callFor("blocked", "unchecked", false).text, strings.issue.call.blocked);
  assert.equal(callFor(undefined, "unchecked", true).text, strings.issue.call.closed);
  assert.equal(callFor("yours:decision", "still-blocking", true).tone, "waiting");
  for (const classification of Classification.options) {
    const call = callFor(classification, "unchecked", false);
    assert.ok(call.text.length > 0, `${classification} has no call`);
    assert.equal(call.tone, isYours(classification) ? "yours" : "waiting", classification);
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
        unresolved: 3,
      },
    }),
  );
  const method = "It cannot see anything outside that.";
  assert.ok(strings.issue.stale.method.endsWith(method));
  assert.equal(markup.split(method).length - 1, 1, "the method is stated once, not once per finding");
  assert.match(markup, /3 references could not be checked; they are recorded under Problems\./);
  assert.doesNotMatch(markup, /could not resolve/);

  const one = pageMarkup(
    aPreview({
      staleness: { verdict: "still-blocking", checked: true, evidence: ["a"], unresolved: 1 },
    }),
  );
  assert.match(one, /1 reference could not be checked; it is recorded under Problems\./);

  const none = pageMarkup(aPreview());
  assert.doesNotMatch(none, /could not be checked/);
});

test("a verdict with no evidence to act on says so rather than showing an empty list", () => {
  const markup = pageMarkup(
    aPreview({
      staleness: { verdict: "still-blocking", checked: true, evidence: [], unresolved: 0 },
    }),
  );
  assert.match(markup, /Checked; nothing has changed that this check can see\./);
  assert.doesNotMatch(markup, /<ul class="pw-evidence">/);
});

test("the preview a click starts from is the snapshot's own record of the issue", () => {
  const snapshot = snapshotOf([
    project("session-replay", {
      issues: [issue("sr-15s2", "yours:decision", { labels: ["needs-access"], staleness: { verdict: "still-blocking", checkedAt: "2026-09-08T13:00:00Z", evidence: ["site#1128 is closed, not merged"] } })],
      errors: [
        { source: "staleness sr-15s2", message: "3 references could not be checked: ext#144, ext#148, ext#150", at: GENERATED_AT },
        { source: "staleness sr-other", message: "1 reference could not be checked: ext#9", at: GENERATED_AT },
      ],
    }),
  ]);
  const preview = previewIssue(snapshot, "session-replay", "sr-15s2");
  assert.equal(preview?.title, "title for sr-15s2");
  assert.equal(preview?.projectName, "session-replay");
  assert.equal(preview?.classification, "yours:decision");
  assert.equal(preview?.closed, false);
  assert.deepEqual(preview?.staleness.evidence, ["site#1128 is closed, not merged"]);
  assert.equal(preview?.staleness.unresolved, 3, "only this issue's own failed lookups are counted");
  assert.equal(previewIssue(snapshot, "session-replay", "sr-nope"), undefined);
  assert.equal(previewIssue(snapshot, "nowhere", "sr-15s2"), undefined);
});

test("the count of references a check could not make is the count the failure recorded", () => {
  const view = buildIssueView({
    ...payload({ staleness: { verdict: "still-blocking", evidence: ["site#1128 is closed, not merged"] } }),
    errors: [
      { source: "staleness sr-i6yt", message: "2 references could not be checked: ext#144, ext#148", at: GENERATED_AT },
      { source: "staleness sr-i6yt", message: "1 precondition could not be run: `npm whoami`", at: GENERATED_AT },
    ],
  });
  assert.equal(view.staleness.unresolved, 3);
  assert.deepEqual(view.staleness.evidence, ["site#1128 is closed, not merged"]);
  assert.equal(buildIssueView(payload()).staleness.unresolved, 0);
});
