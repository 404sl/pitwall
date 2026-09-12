import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Classification, SCHEMA_VERSION, isYours, parseSnapshot } from "@404sl/pitwall-schema";
import type { CollectionError } from "@404sl/pitwall-schema";
import {
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
  problemGroups,
  problemKey,
  snapshotAge,
} from "../ui/model.ts";
import type { Board, BuildState, FilterState, IssuePayload, IssuePreview, ProblemRow } from "../ui/model.ts";
import { strings } from "../ui/strings.ts";
import { countLabel } from "../ui/format.ts";
import { boardHref, filterOf, filterQuery, issueHref, routeOf } from "../ui/routes.ts";
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
): string {
  const realNow = Date.now;
  Date.now = () => HEADER_NOW;
  try {
    return renderToStaticMarkup(
      createElement(Header, { projectCount, generatedAt, version: VERSION, update, refreshFailure, build }),
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
  assert.equal(callFor("landing", "unchecked", false).text, strings.issue.call.landing.standing);
  assert.deepEqual(callFor("landing", "still-blocking", false), {
    text: strings.issue.call.landing.standing,
    tone: "waiting",
  });
  assert.deepEqual(callFor("landing", "likely-stale", false), {
    text: strings.issue.call.landing.stale,
    tone: "yours",
  });
  assert.deepEqual(callFor("landing", "resolved", false), {
    text: strings.issue.call.landing.stale,
    tone: "yours",
  });
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

test("a landing issue whose pull request merged asks the reader to close it", () => {
  const markup = pageMarkup(
    aPreview({
      classification: "landing",
      staleness: {
        verdict: "likely-stale",
        checked: true,
        checkedAt: "2026-09-10T09:40:00Z",
        evidence: ["the pull request it waits on has merged: #91"],
        unresolved: [],
      },
    }),
  );
  assert.match(markup, /class="pw-call pw-call--yours">Its pull request merged\./);
  assert.doesNotMatch(markup, /Nothing for you/, "the call no longer disagrees with the staleness band");
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
        unresolved: [{ kind: "reference", count: 3 }],
      },
    }),
  );
  const method = "It cannot see anything outside that.";
  assert.ok(strings.issue.stale.method.endsWith(method));
  assert.equal(markup.split(method).length - 1, 1, "the method is stated once, not once per finding");
  assert.match(markup, /3 references could not be checked; they are recorded in the snapshot\./);
  assert.doesNotMatch(markup, /could not resolve/);

  const one = pageMarkup(
    aPreview({
      staleness: {
        verdict: "still-blocking",
        checked: true,
        evidence: ["a"],
        unresolved: [{ kind: "reference", count: 1 }],
      },
    }),
  );
  assert.match(one, /1 reference could not be checked; it is recorded in the snapshot\./);

  const none = pageMarkup(aPreview());
  assert.doesNotMatch(none, /could not be checked/);
});

test("a precondition nobody could run is named as one, not as a reference nobody checked", () => {
  const only = pageMarkup(
    aPreview({
      staleness: {
        verdict: "unchecked",
        checked: false,
        evidence: [],
        unresolved: [{ kind: "precondition", count: 1 }],
      },
    }),
  );
  assert.match(only, /1 precondition could not be run; it is recorded in the snapshot\./);
  assert.doesNotMatch(only, /could not be checked/, "there was no reference, so none is claimed");
  assert.doesNotMatch(only, /reference/);

  const both = pageMarkup(
    aPreview({
      staleness: {
        verdict: "still-blocking",
        checked: true,
        evidence: ["a"],
        unresolved: [
          { kind: "reference", count: 2 },
          { kind: "precondition", count: 3 },
        ],
      },
    }),
  );
  assert.match(both, /2 references could not be checked; they are recorded in the snapshot\./);
  assert.match(both, /3 preconditions could not be run; they are recorded in the snapshot\./);
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
  assert.deepEqual(
    preview?.staleness.unresolved,
    [{ kind: "reference", count: 3 }],
    "only this issue's own failed lookups are counted",
  );
  assert.equal(previewIssue(snapshot, "session-replay", "sr-nope"), undefined);
  assert.equal(previewIssue(snapshot, "nowhere", "sr-15s2"), undefined);
});

test("each kind of failed check is counted as its own kind, never summed into references", () => {
  const view = buildIssueView({
    ...payload({ staleness: { verdict: "still-blocking", evidence: ["site#1128 is closed, not merged"] } }),
    errors: [
      { source: "staleness sr-i6yt", message: "2 references could not be checked: ext#144, ext#148", at: GENERATED_AT },
      { source: "staleness sr-i6yt", message: "1 precondition could not be run: `npm whoami`", at: GENERATED_AT },
    ],
  });
  assert.deepEqual(view.staleness.unresolved, [
    { kind: "reference", count: 2 },
    { kind: "precondition", count: 1 },
  ]);
  assert.deepEqual(view.staleness.evidence, ["site#1128 is closed, not merged"]);

  const probed = buildIssueView({
    ...payload(),
    errors: [
      { source: "staleness sr-i6yt", message: "1 precondition could not be run: `npm whoami`", at: GENERATED_AT },
    ],
  });
  assert.deepEqual(
    probed.staleness.unresolved,
    [{ kind: "precondition", count: 1 }],
    "a probe nobody could run is no reference at all",
  );

  const unnumbered = buildIssueView({
    ...payload(),
    errors: [
      {
        source: "staleness sr-i6yt",
        message: "no pull request host is configured, so pull requests could not be looked up",
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
const { Problems } = await import("../ui/components/Problems.tsx");

const MIXED_PROJECTS = [
  project("pitwall", {
    issues: [
      issue("pitwall-4b5", "yours:decision", { issueType: "epic" }),
      issue("pitwall-4b5.1", "yours:decision", { issueType: "bug" }),
      issue("pitwall-4b5.2", "ready", { issueType: "task", priority: 2 }),
      issue("pitwall-7qq", "ready", { issueType: undefined, priority: undefined }),
    ],
    lanes: [
      { slot: 1, state: "working", issueId: "pitwall-4b5.2" },
      { slot: 2, state: "stranded" },
    ],
  }),
  project("session-replay", {
    issues: [issue("sr-1aa", "ready", { issueType: "chore", priority: 3 })],
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
  { project: "session-replay", type: "zzz", priority: "4", epic: "nothing" },
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

const RATE_LIMITED = "API rate limit exceeded for user ID 2201. (HTTP 403)";
const LIST_COMMAND =
  "gh pr list --repo 404sl/pitwall --state open --limit 200 --json number,title,labels,headRefName,url,statusCheckRollup,body";
const COLLECTED_AT = "2026-09-12T00:11:00Z";

function unreadable(source: string, message: string, name = "pitwall"): ProblemRow {
  return { scope: "project", name, source, message, at: COLLECTED_AT };
}

function uncheckable(index: number, kind: "reference" | "precondition", name = "pitwall"): ProblemRow {
  const count = (index % 3) + 1;
  const noun = count === 1 ? kind : `${kind}s`;
  const verb = kind === "reference" ? "checked" : "run";
  return unreadable(
    `staleness pitwall-${index.toString(36)}`,
    `${count} ${noun} could not be ${verb}: #${index + 40}`,
    name,
  );
}

function tbodyOf(markup: string, id: string): string {
  const opened = markup.split(`<tbody id="${id}"`)[1] ?? "";
  return opened.split("</tbody>")[0] ?? "";
}

test("a rate limit that stopped every check is one row naming the cause, not one row per issue", () => {
  const rows = [
    unreadable(LIST_COMMAND, RATE_LIMITED),
    unreadable("staleness", "no pull request host is configured, so pull requests could not be looked up"),
    ...Array.from({ length: 121 }, (_, index) => uncheckable(index, "reference", index % 4 === 0 ? "session-replay" : "pitwall")),
  ];
  const entries = problemGroups(rows);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["rows", "group"],
    "the failures that are different must stay ahead of the collapsed cause",
  );
  const markup = renderToStaticMarkup(createElement(Problems, { rows }));
  assert.match(markup, /121 issues/);
  assert.match(markup, /references could not be checked/);
  assert.equal(markup.match(/aria-expanded="false"/g)?.length, 1, "one cause collapses to one toggle");
  assert.match(markup, /2 projects/, "a cause that crossed projects must say so");
  assert.ok(markup.includes(LIST_COMMAND), "the command somebody re-runs must survive collapsing");
  assert.ok(markup.includes(RATE_LIMITED));
  for (const row of rows) {
    assert.equal(markup.match(new RegExp(row.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length, 1);
  }
  const detail = tbodyOf(markup, "problems-staleness-reference");
  assert.match(detail, /^ class="pw-problems__detail" hidden=""/, "a group starts collapsed");
  assert.ok(!detail.includes(LIST_COMMAND), "the row that is different must not be hidden inside a group");
  assert.ok(!detail.includes("no pull request host is configured"), "a run-scope failure is not a per-issue one");
  assert.equal(detail.match(/could not be checked/g)?.length, 121, "expanding must give every issue back");
});

test("a long source renders in a column of its own, because the message column is not for commands", () => {
  const markup = renderToStaticMarkup(
    createElement(Problems, { rows: [unreadable(LIST_COMMAND, RATE_LIMITED)] }),
  );
  assert.match(markup, /pw-cell pw-cell--source/, "a source is a command, not an id");
  assert.ok(!markup.includes("pw-cell--id"), "the id column is measured for ids and must not size a command");
});

test("problems group on the cause they share, never on the message they do not", () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, index) => uncheckable(index, "reference")),
    ...Array.from({ length: 3 }, (_, index) => uncheckable(index + 10, "precondition")),
  ];
  const entries = problemGroups(rows);
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "group" ? entry.cause : entry.kind)),
    ["reference", "precondition"],
  );
  const markup = renderToStaticMarkup(createElement(Problems, { rows }));
  assert.equal(markup.match(/aria-expanded="false"/g)?.length, 2);
  assert.match(markup, /2 issues/);
  assert.match(markup, /3 issues/);
  assert.match(markup, /preconditions could not be run/);
});

test("one failure of a cause stays the row it was, because there is nothing to collapse", () => {
  const rows = [uncheckable(1, "reference"), unreadable("staleness pitwall-9x", "the note could not be parsed")];
  assert.deepEqual(
    problemGroups(rows).map((entry) => entry.kind),
    ["rows"],
  );
  const markup = renderToStaticMarkup(createElement(Problems, { rows }));
  assert.ok(!markup.includes("aria-expanded"), "a single row must not grow a toggle");
  assert.ok(!markup.includes("pw-problems__detail"), "a single row must not hide behind a disclosure");
});

test("a console failure is never collapsed and keeps the live region a reader is told through", () => {
  const rows: ProblemRow[] = [
    { scope: "console", name: "console", source: "staleness pitwall-1", message: "2 references could not be checked: #1", at: COLLECTED_AT },
    { scope: "console", name: "console", source: "staleness pitwall-2", message: "3 references could not be checked: #2", at: COLLECTED_AT },
  ];
  assert.deepEqual(
    problemGroups(rows).map((entry) => entry.kind),
    ["rows"],
  );
  const markup = renderToStaticMarkup(createElement(Problems, { rows }));
  assert.equal(markup.match(/role="status"/g)?.length, 2);
  assert.ok(!markup.includes("aria-expanded"));
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
  assert.equal((markup.match(/<select/g) ?? []).length, 4);
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

test("only an issue in the owner's own queue offers anything to do about it", () => {
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
  const view = buildIssueView(payload({ classification: "ready" }));
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
  );
});
