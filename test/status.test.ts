import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, parseSnapshot } from "@404sl/pitwall-schema";
import { READY_PER_PROJECT, renderStatus, parseStatusArgs, terminalWidth, wantsColor } from "../src/status.ts";
import { VERSION } from "../src/version.ts";

const GENERATED_AT = "2026-09-08T14:11:00Z";
const ESCAPE = /\u001b\[/;

function issue(id: string, classification: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `title for ${id}`, status: "open", priority: 1, classification, ...extra };
}

function repeated(prefix: string, classification: string, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => issue(`${prefix}-${index}`, classification));
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

function error(source: string, message: string): Record<string, unknown> {
  return { source, message, at: GENERATED_AT };
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

const BUSY = snapshotOf([
  project("session-replay", {
    issues: [
      issue("sr-1", "yours:decision", { priority: 0, staleness: { verdict: "likely-stale" } }),
      issue("sr-2", "yours:access", { priority: 2, staleness: { verdict: "still-blocking" } }),
      ...repeated("sr-park", "parked:tooling", 4),
      ...repeated("sr-watch", "parked:watch", 6),
      ...repeated("sr-block", "blocked", 9),
      ...repeated("sr-ready", "ready", 5),
    ],
    lanes: [
      { slot: 1, state: "working", issueId: "sr-30", lastActivityAt: "2026-09-08T13:11:00Z" },
      { slot: 2, state: "handed-off", issueId: "sr-31", lastActivityAt: "2026-09-08T14:01:00Z" },
    ],
  }),
  project("pitwall", {
    issues: [...repeated("pw-you", "yours:decision", 3), issue("pw-ready", "ready")],
  }),
]);

const LONG_TITLE =
  "decide whether the collector keeps reading a tracker after the first query comes back empty";
const LONG_ERROR =
  "bd exited 1: could not open /projects/unreadable/.beads/issues.db, the file is held by another process";

const WIDE = snapshotOf([
  project("session-replay", {
    issues: [
      issue("sr-1", "yours:decision", { priority: 0, title: LONG_TITLE, staleness: { verdict: "likely-stale" } }),
      issue("sr-ready-0", "ready", { title: LONG_TITLE }),
    ],
    lanes: Array.from({ length: 6 }, (_, index) => ({
      slot: index + 1,
      state: "working",
      issueId: `sr-lane-${index}`,
      lastActivityAt: "2026-09-08T13:11:00Z",
    })),
  }),
  project("unreadable", { errors: [error("/projects/unreadable/.beads", LONG_ERROR)] }),
]);

test("every section of the screen is rendered from a snapshot alone", () => {
  const out = renderStatus(BUSY);
  for (const band of ["NEEDS YOU", "RUNNING", "READY", "PARKED", "PROBLEMS"]) {
    assert.match(out, new RegExp(`^${band}`, "m"));
  }
  const order = ["NEEDS YOU", "RUNNING", "READY", "PARKED", "PROBLEMS"].map((band) => out.indexOf(band));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("needs you carries the id, priority, title and staleness of each of yours, and nothing else", () => {
  const out = renderStatus(BUSY);
  const needs = out.slice(out.indexOf("NEEDS YOU"), out.indexOf("RUNNING"));
  assert.match(needs, /sr-1 +P0 +decision +likely stale +title for sr-1/);
  assert.match(needs, /sr-2 +P2 +access +still blocking +title for sr-2/);
  assert.match(needs, /^ {2}session-replay$/m);
  assert.match(needs, /^ {2}pitwall$/m);
  assert.doesNotMatch(needs, /sr-park|sr-block|sr-ready/);
});

test("parked is counted per reason and never summed into a total", () => {
  const out = renderStatus(BUSY);
  const parked = out.slice(out.indexOf("PARKED"), out.indexOf("PROBLEMS"));
  assert.match(parked, /^ {2}tooling +4$/m);
  assert.match(parked, /^ {2}watch +6$/m);
  assert.match(parked, /^ {2}blocked +9$/m);
  assert.doesNotMatch(out, /\b19\b/);
  assert.doesNotMatch(out, /\b24\b/);
});

test("running reports handed-off separately from working, with how long each lane has been at it", () => {
  const running = renderStatus(BUSY);
  const section = running.slice(running.indexOf("RUNNING"), running.indexOf("READY"));
  assert.match(section, /^RUNNING 1 working \u00b7 1 awaiting lander$/m);
  assert.match(section, /1 working .*sr-30 1h0m/);
  assert.match(section, /1 awaiting lander .*sr-31 10m/);
  assert.doesNotMatch(section, /^RUNNING 2$/m);
});

test("ready shows the top few per project rather than a global handful", () => {
  const out = renderStatus(BUSY);
  const ready = out.slice(out.indexOf("READY"), out.indexOf("PARKED"));
  const shown = ready.match(/^ +sr-ready-\d+ /gm) ?? [];
  assert.equal(shown.length, READY_PER_PROJECT);
  assert.match(ready, /\+2 more ready/);
  assert.match(ready, /pw-ready/);
});

test("a project that could not be read appears under problems, not as an empty backlog", () => {
  const out = renderStatus(
    snapshotOf([
      project("session-replay", { issues: [issue("sr-1", "ready")] }),
      project("unreadable", { errors: [error("/projects/unreadable/.beads", "bd exited 1")] }),
    ]),
  );
  const before = out.slice(0, out.indexOf("PROBLEMS"));
  assert.doesNotMatch(before, /unreadable/);
  const problems = out.slice(out.indexOf("PROBLEMS"));
  assert.match(problems, /unreadable .*bd exited 1/);
});

test("a snapshot with no projects says so, in the words the collector recorded", () => {
  const out = renderStatus(snapshotOf([], [error("/work", "0 workspace roots found by falling back to scanning /work")]));
  assert.match(out, /0 projects/);
  assert.match(out, /No projects to report\./);
  assert.match(out, /0 workspace roots found by falling back to scanning \/work/);
  assert.doesNotMatch(out, /NEEDS YOU/);
});

test("no projects and no recorded reason still says something rather than showing an empty screen", () => {
  const out = renderStatus(snapshotOf([]));
  assert.match(out, /No projects to report\./);
  assert.match(out, /names a workspace root/);
});

test("projects with nothing to do read differently from having no projects", () => {
  const out = renderStatus(snapshotOf([project("session-replay"), project("pitwall")]));
  assert.match(out, /2 projects/);
  assert.doesNotMatch(out, /No projects to report/);
  assert.match(out, /Nothing needs you\./);
  assert.match(out, /No lane is running\./);
  assert.match(out, /Nothing is ready to pick up\./);
  assert.match(out, /Nothing parked\./);
  assert.match(out, /Every project read cleanly\./);
});

test("colour is off unless it is asked for, and the plain text is the same words", () => {
  const plain = renderStatus(BUSY);
  const coloured = renderStatus(BUSY, { color: true });
  assert.doesNotMatch(plain, ESCAPE);
  assert.match(coloured, ESCAPE);
  assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ""), plain);
});

test("NO_COLOR wins over a TTY, and an empty NO_COLOR does not", () => {
  assert.equal(wantsColor({ NO_COLOR: "1" }, true), false);
  assert.equal(wantsColor({ NO_COLOR: "" }, true), true);
  assert.equal(wantsColor({}, true), true);
});

test("a stdout that is not a terminal gets plain output", () => {
  assert.equal(wantsColor({}, false), false);
  assert.doesNotMatch(renderStatus(BUSY, { color: wantsColor({}, false) }), ESCAPE);
});

test("status reads the state path by default and another file with --from", () => {
  assert.deepEqual(parseStatusArgs([]), {});
  assert.deepEqual(parseStatusArgs(["--from", "/tmp/snap.json"]), { from: "/tmp/snap.json" });
  assert.deepEqual(parseStatusArgs(["--from=/tmp/snap.json"]), { from: "/tmp/snap.json" });
});

test("--from without a path is an error rather than a silent default", () => {
  assert.deepEqual(parseStatusArgs(["--from"]), { error: "--from expects a path, got nothing" });
  assert.deepEqual(parseStatusArgs(["--nope"]), { error: "unknown argument --nope" });
});

test("a narrow terminal keeps the columns lined up instead of wrapping mid-word", () => {
  const narrow = renderStatus(WIDE, { width: 80 });
  for (const line of narrow.slice(0, narrow.indexOf("PROBLEMS")).split("\n")) {
    assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
  }
  assert.match(narrow, /\u2026/);
  assert.ok(renderStatus(WIDE).split("\n").some((line) => line.length > 80));
});

test("truncation counts the words rather than the colour codes", () => {
  const coloured = renderStatus(WIDE, { width: 80, color: true });
  assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ""), renderStatus(WIDE, { width: 80 }));
});

test("an error is never cut short to fit the screen", () => {
  const narrow = renderStatus(WIDE, { width: 80 });
  assert.ok(narrow.slice(narrow.indexOf("PROBLEMS")).includes(LONG_ERROR));
});

test("a width with room to spare changes nothing, and piped output has no width at all", () => {
  assert.equal(renderStatus(WIDE, { width: 10_000 }), renderStatus(WIDE));
  assert.ok(renderStatus(WIDE).includes(LONG_TITLE));
  assert.doesNotMatch(renderStatus(WIDE), /\u2026/);
  assert.equal(terminalWidth({ isTTY: false, columns: 120 }), undefined);
  assert.equal(terminalWidth({ isTTY: true, columns: 80 }), 80);
  assert.equal(terminalWidth({}), undefined);
});
