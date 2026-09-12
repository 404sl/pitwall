import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, parseSnapshot, type CollectionError, type Snapshot } from "@404sl/pitwall-schema";
import { buildBoard } from "../src/board.ts";
import { SELF_HEALING_GRACE_MS, carryFailingSince, dispositionOf } from "../src/problems.ts";
import { renderStatus } from "../src/status.ts";
import { VERSION } from "../src/version.ts";

const GENERATED_AT = "2026-09-12T12:00:00Z";
const NOW = Date.parse(GENERATED_AT);

const RATE_LIMIT = "GraphQL: API rate limit already exceeded for user ID 1";
const UNRECORDED_STOP =
  "nothing records when an issue stopped or when the newest note was written, so a note written since cannot be recognised";

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function unchecked(id: string, count: number, at = GENERATED_AT): CollectionError {
  const named = Array.from({ length: count }, (_, index) => `#${index + 1}`).join(", ");
  return {
    source: `staleness ${id}`,
    message: `${count} ${count === 1 ? "reference" : "references"} could not be checked: ${named}`,
    at,
  };
}

function snapshotOfProjects(
  projects: { id: string; errors: CollectionError[] }[],
  runErrors: CollectionError[] = [],
): Snapshot {
  return parseSnapshot({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: GENERATED_AT,
    agent: { version: VERSION, executor: "local" },
    projects: projects.map((project) => ({
      id: project.id,
      name: project.id,
      root: `/projects/${project.id}`,
      authority: { kind: "beads" },
      metrics: {},
      issues: [],
      errors: project.errors,
    })),
    errors: runErrors,
  });
}

function snapshotOf(errors: CollectionError[], runErrors: CollectionError[] = []): Snapshot {
  return snapshotOfProjects([{ id: "pitwall", errors }], runErrors);
}

test("a rate limit that may still clear is not a problem, and nor are the checks it prevented", () => {
  const board = buildBoard(
    snapshotOf([
      { source: "gh pr view", message: RATE_LIMIT, at: GENERATED_AT },
      unchecked("pitwall-a", 15),
      unchecked("pitwall-b", 1),
      unchecked("pitwall-c", 4),
    ]),
  );
  assert.deepEqual(board.problems, []);
});

test("a rate limit that has not cleared in six hours is one row carrying what it prevented", () => {
  const started = ago(SELF_HEALING_GRACE_MS + 60_000);
  const board = buildBoard(
    snapshotOf([
      { source: "gh pr view", message: RATE_LIMIT, at: started },
      unchecked("pitwall-a", 15),
      unchecked("pitwall-b", 1),
      unchecked("pitwall-c", 4),
    ]),
  );
  assert.equal(board.problems.length, 1);
  assert.equal(board.problems[0]?.source, "gh pr view");
  assert.equal(board.problems[0]?.message, RATE_LIMIT);
  assert.equal(board.problems[0]?.at, started);
  assert.equal(board.problems[0]?.prevented, 3, "three checks failed, not twenty references");
});

test("a cause that cannot heal on its own is a problem on the first board that records it", () => {
  const board = buildBoard(
    snapshotOf([
      { source: "gh pr view", message: "spawn gh ENOENT", at: GENERATED_AT },
      unchecked("pitwall-a", 2),
    ]),
  );
  assert.equal(board.problems.length, 1);
  assert.equal(board.problems[0]?.prevented, 1);
});

test("a precondition nobody could run is counted against the command that would not run", () => {
  const board = buildBoard(
    snapshotOf([
      { source: "gh auth status", message: "timed out after 10000ms", at: ago(7 * 60 * 60_000) },
      {
        source: "staleness pitwall-a",
        message: "1 precondition could not be run: `gh auth status`",
        at: GENERATED_AT,
      },
    ]),
  );
  assert.equal(board.problems.length, 1);
  assert.equal(board.problems[0]?.source, "gh auth status");
  assert.equal(board.problems[0]?.prevented, 1);
});

test("a board with nothing wrong beyond what no tracker records has no problems at all", () => {
  const board = buildBoard(snapshotOf([{ source: "staleness", message: UNRECORDED_STOP, at: GENERATED_AT }]));
  assert.deepEqual(board.problems, []);
  assert.equal(dispositionOf({ source: "staleness", message: UNRECORDED_STOP, at: GENERATED_AT }), "limitation");
});

test("a tracker that could not be read is a problem at any age, because an empty band reads as no backlog", () => {
  const board = buildBoard(
    snapshotOf([{ source: "bd list", message: "timed out after 10000ms", at: GENERATED_AT }]),
  );
  assert.equal(board.problems.length, 1);
  assert.equal(board.problems[0]?.source, "bd list");
});

test("the board filters; the snapshot still records every failure a reader could not read", () => {
  const snapshot = snapshotOf([
    { source: "gh pr view", message: RATE_LIMIT, at: GENERATED_AT },
    { source: "staleness", message: UNRECORDED_STOP, at: GENERATED_AT },
    unchecked("pitwall-a", 3),
  ]);
  assert.equal(buildBoard(snapshot).problems.length, 0);
  assert.equal(snapshot.projects[0]?.errors.length, 3, "a consumer that wants everything still has it");
});

test("a failure that is still failing keeps the instant it started, so duration can be read from one board", () => {
  const started = ago(SELF_HEALING_GRACE_MS + 60_000);
  const previous = snapshotOf([
    { source: "gh pr view", message: RATE_LIMIT, at: started },
    { source: "bd list", message: "exited 1", at: started },
  ]);
  const current = snapshotOf([
    { source: "gh pr view", message: `${RATE_LIMIT}, and a request id nobody can match`, at: GENERATED_AT },
    { source: "bd list", message: "exited 1", at: GENERATED_AT },
  ]);
  const carried = carryFailingSince(current, previous);
  assert.equal(carried.projects[0]?.errors[0]?.at, started, "the rate limit has been failing since then");
  assert.equal(carried.projects[0]?.errors[1]?.at, GENERATED_AT, "a failure nobody calls self-healing is untouched");
  assert.deepEqual(
    buildBoard(carried).problems.map((row) => row.source),
    ["gh pr view", "bd list"],
    "a failure dated six hours back is shown; one nobody calls self-healing was always shown",
  );
});

test("a first board carries nothing forward and a cleared failure starts again", () => {
  const current = snapshotOf([{ source: "gh pr view", message: RATE_LIMIT, at: GENERATED_AT }]);
  assert.equal(carryFailingSince(current, undefined).projects[0]?.errors[0]?.at, GENERATED_AT);
  const unrelated = snapshotOf([{ source: "gh pr view", message: "spawn gh ENOENT", at: ago(9 * 60 * 60_000) }]);
  assert.equal(
    carryFailingSince(current, unrelated).projects[0]?.errors[0]?.at,
    GENERATED_AT,
    "what was not healing itself does not date a failure that is",
  );
});

test("the status screen names the cause and counts the consequences", () => {
  const out = renderStatus(
    snapshotOf([
      { source: "gh pr view", message: RATE_LIMIT, at: ago(7 * 60 * 60_000) },
      unchecked("pitwall-a", 15),
      unchecked("pitwall-b", 1),
    ]),
    { now: NOW },
  );
  const band = out.slice(out.indexOf("PROBLEMS"));
  assert.match(band, /gh pr view/);
  assert.match(band, /prevented 2 staleness checks/);
  assert.doesNotMatch(band, /could not be checked/);
});

test("staleness checks nothing explains are one row per project with a count, not silence", () => {
  const started = ago(3 * 60 * 60_000);
  const board = buildBoard(
    snapshotOfProjects([
      { id: "pitwall", errors: [unchecked("pitwall-a", 15, started), unchecked("pitwall-b", 1), unchecked("pitwall-c", 4)] },
      { id: "session-replay", errors: [unchecked("sr-a", 2)] },
    ]),
  );
  assert.deepEqual(
    board.problems.map((row) => [row.name, row.source, row.message]),
    [
      ["pitwall", "staleness", "3 staleness checks could not complete and nothing recorded why"],
      ["session-replay", "staleness", "1 staleness check could not complete and nothing recorded why"],
    ],
  );
  assert.equal(board.problems[0]?.at, started, "it has been failing since the earliest check it could not run");
});

test("a check its recorded cause explains is counted against it; one nothing explains still shows", () => {
  const board = buildBoard(
    snapshotOf([
      { source: "gh pr view", message: "spawn gh ENOENT", at: GENERATED_AT },
      unchecked("pitwall-a", 2),
      {
        source: "staleness pitwall-b",
        message: "1 precondition could not be run: `npm whoami`",
        at: GENERATED_AT,
      },
    ]),
  );
  assert.deepEqual(
    board.problems.map((row) => [row.source, row.prevented]),
    [
      ["gh pr view", 1],
      ["staleness", undefined],
    ],
  );
  assert.equal(
    board.problems[1]?.message,
    "1 staleness check could not complete and nothing recorded why",
  );
});

test("the status screen says what could not complete when nothing recorded why", () => {
  const out = renderStatus(snapshotOf([unchecked("pitwall-a", 15), unchecked("pitwall-b", 1)]), {
    now: NOW,
  });
  const band = out.slice(out.indexOf("PROBLEMS"));
  assert.match(band, /2 staleness checks could not complete and nothing recorded why/);
  assert.doesNotMatch(band, /could not be checked/);
});

test("checks a reference nothing could place prevented are counted against that cause, not unexplained", () => {
  const started = ago(3 * 60 * 60_000);
  const board = buildBoard(
    snapshotOf([
      {
        source: "pull reference",
        message:
          "2 pull references could not be placed. 4 repositories are configured. #130, #131 name no repository.",
        at: started,
      },
      unchecked("pitwall-a", 1),
      unchecked("pitwall-b", 1),
    ]),
  );
  assert.deepEqual(
    board.problems.map((row) => [row.source, row.prevented]),
    [["pull reference", 2]],
  );
  assert.equal(board.problems[0]?.at, started);
});

test("the status screen names an unplaceable reference as the cause of the checks it stopped", () => {
  const out = renderStatus(
    snapshotOf([
      {
        source: "pull reference",
        message:
          "1 pull reference could not be placed. 2 repositories are configured. #130 names no repository.",
        at: GENERATED_AT,
      },
      unchecked("pitwall-a", 1),
    ]),
    { now: NOW },
  );
  const band = out.slice(out.indexOf("PROBLEMS"));
  assert.match(band, /pull reference +1 pull reference could not be placed\./);
  assert.match(band, /prevented 1 staleness check/);
  assert.doesNotMatch(band, /nothing recorded why/);
});
