import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, parseSnapshot, type Snapshot } from "@404sl/pitwall-schema";
import {
  READY_PER_PROJECT,
  SNAPSHOT_STALE_AFTER_MS,
  missingSnapshotMessage,
  renderStatus,
  parseStatusArgs,
  terminalWidth,
  wantsColor,
  type StatusOptions,
} from "../src/status.ts";
import { VERSION } from "../src/version.ts";
import { displayWidth, eastAsianWidth } from "../src/width.ts";

const GENERATED_AT = "2026-09-08T14:11:00Z";
const NOW = Date.parse(GENERATED_AT);
const ESCAPE = /\u001b\[/;
const WIDE_ROW_PREFIX = "    sr-1 P0 decision still blocking ";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function render(snapshot: Snapshot, options: StatusOptions = {}): string {
  return renderStatus(snapshot, { now: NOW, ...options });
}

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

function titled(title: string) {
  return snapshotOf([
    project("session-replay", {
      issues: [issue("sr-1", "yours:decision", { priority: 0, title, staleness: { verdict: "still-blocking" } })],
    }),
  ]);
}

function lineAt(out: string, index: number): string {
  const line = out.split("\n")[index];
  assert.ok(line !== undefined, `no line ${index} in ${out}`);
  return line;
}

function runningRow(out: string): string {
  const band = out.slice(out.indexOf("RUNNING"), out.indexOf("READY"));
  const row = band.split("\n").find((line) => line.startsWith("  session-replay"));
  assert.ok(row !== undefined, `no running row in ${out}`);
  return row;
}

function rowFor(out: string, id: string): string {
  const row = out.split("\n").find((line) => line.includes(id));
  assert.ok(row !== undefined, `no row for ${id} in ${out}`);
  return row;
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
  const out = render(BUSY);
  for (const band of ["NEEDS YOU", "RUNNING", "READY", "PARKED", "PROBLEMS"]) {
    assert.match(out, new RegExp(`^${band}`, "m"));
  }
  const order = ["NEEDS YOU", "RUNNING", "READY", "PARKED", "PROBLEMS"].map((band) => out.indexOf(band));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("needs you carries the id, priority, title and staleness of each of yours, and nothing else", () => {
  const out = render(BUSY);
  const needs = out.slice(out.indexOf("NEEDS YOU"), out.indexOf("RUNNING"));
  assert.match(needs, /sr-1 +P0 +decision +likely stale +title for sr-1/);
  assert.match(needs, /sr-2 +P2 +access +still blocking +title for sr-2/);
  assert.match(needs, /^ {2}session-replay$/m);
  assert.match(needs, /^ {2}pitwall$/m);
  assert.doesNotMatch(needs, /sr-park|sr-block|sr-ready/);
});

test("parked is counted per reason and never summed into a total", () => {
  const out = render(BUSY);
  const parked = out.slice(out.indexOf("PARKED"), out.indexOf("PROBLEMS"));
  assert.match(parked, /^ {2}tooling +4$/m);
  assert.match(parked, /^ {2}watch +6$/m);
  assert.match(parked, /^ {2}blocked +9$/m);
  assert.doesNotMatch(out, /\b19\b/);
  assert.doesNotMatch(out, /\b24\b/);
});

test("running reports handed-off separately from working, with how long each lane has been at it", () => {
  const running = render(BUSY);
  const section = running.slice(running.indexOf("RUNNING"), running.indexOf("READY"));
  assert.match(section, /^RUNNING 1 working \u00b7 1 awaiting lander$/m);
  assert.match(section, /1 working .*sr-30 1h0m/);
  assert.match(section, /1 awaiting lander .*sr-31 10m/);
  assert.doesNotMatch(section, /^RUNNING 2$/m);
});

test("ready shows the top few per project rather than a global handful", () => {
  const out = render(BUSY);
  const ready = out.slice(out.indexOf("READY"), out.indexOf("PARKED"));
  const shown = ready.match(/^ +sr-ready-\d+ /gm) ?? [];
  assert.equal(shown.length, READY_PER_PROJECT);
  assert.match(ready, /\+2 more ready/);
  assert.match(ready, /pw-ready/);
});

test("a project that could not be read appears under problems, not as an empty backlog", () => {
  const out = render(
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
  const out = render(snapshotOf([], [error("/work", "0 workspace roots found by falling back to scanning /work")]));
  assert.match(out, /0 projects/);
  assert.match(out, /No projects to report\./);
  assert.match(out, /0 workspace roots found by falling back to scanning \/work/);
  assert.doesNotMatch(out, /NEEDS YOU/);
});

test("no projects and no recorded reason still says something rather than showing an empty screen", () => {
  const out = render(snapshotOf([]));
  assert.match(out, /No projects to report\./);
  assert.match(out, /names a workspace root/);
});

test("projects with nothing to do read differently from having no projects", () => {
  const out = render(snapshotOf([project("session-replay"), project("pitwall")]));
  assert.match(out, /2 projects/);
  assert.doesNotMatch(out, /No projects to report/);
  assert.match(out, /Nothing needs you\./);
  assert.match(out, /No lane is running\./);
  assert.match(out, /Nothing is ready to pick up\./);
  assert.match(out, /Nothing parked\./);
  assert.match(out, /Every project read cleanly\./);
});

test("colour is off unless it is asked for, and the plain text is the same words", () => {
  const plain = render(BUSY);
  const coloured = render(BUSY, { color: true });
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
  assert.doesNotMatch(render(BUSY, { color: wantsColor({}, false) }), ESCAPE);
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
  const narrow = render(WIDE, { width: 80 });
  for (const line of narrow.slice(0, narrow.indexOf("PROBLEMS")).split("\n")) {
    assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
  }
  assert.match(narrow, /\u2026/);
  assert.ok(render(WIDE).split("\n").some((line) => line.length > 80));
});

test("truncation counts the words rather than the colour codes", () => {
  for (const width of [80, 36]) {
    const coloured = render(WIDE, { width, color: true });
    assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ""), render(WIDE, { width }));
  }
  for (const width of [80, 40]) {
    const coloured = render(BUSY, { width, color: true });
    assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ""), render(BUSY, { width }));
  }
});

test("an error is never cut short to fit the screen", () => {
  const narrow = render(WIDE, { width: 80 });
  assert.ok(narrow.slice(narrow.indexOf("PROBLEMS")).includes(LONG_ERROR));
});

test("a width with room to spare changes nothing, and piped output has no width at all", () => {
  assert.equal(render(WIDE, { width: 10_000 }), render(WIDE));
  assert.ok(render(WIDE).includes(LONG_TITLE));
  assert.doesNotMatch(render(WIDE), /\u2026/);
  assert.equal(terminalWidth({ isTTY: false, columns: 120 }), undefined);
  assert.equal(terminalWidth({ isTTY: true, columns: 80 }), 80);
  assert.equal(terminalWidth({}), undefined);
});

test("every row stays inside a terminal narrower than eighty columns", () => {
  for (const width of [43, 40, 36, 35]) {
    const out = render(WIDE, { width });
    const band = out.slice(0, out.indexOf("PROBLEMS"));
    for (const line of band.split("\n")) {
      assert.ok(line.length <= width, `width ${width}: ${line.length} columns: ${line}`);
    }
  }
  assert.match(render(WIDE, { width: 35 }), /^ {4}sr-1 P0 decision likely stale \u2026$/m);
});

test("a running row too narrow for every chip ends on a whole lane, a count, or the state", () => {
  const prefixWidth = runningRow(render(WIDE)).indexOf("sr-lane-0");
  for (let width = prefixWidth + 1; width <= prefixWidth + 60; width += 1) {
    const row = runningRow(render(WIDE, { width }));
    assert.doesNotMatch(row, /\u2026/, `width ${width}: ${row}`);
    assert.ok(displayWidth(row) <= width, `width ${width}: ${displayWidth(row)} columns: ${row}`);
    const shown = [...row.matchAll(/sr-lane-\d 1h0m/g)].length;
    const dropped = row.match(/\+(\d+) more/);
    if (shown === 0 && dropped === null) {
      assert.ok(row.endsWith("6 working"), `width ${width}: ${row}`);
      continue;
    }
    assert.match(row, /(?:sr-lane-\d 1h0m|\+\d+ more)$/, `width ${width}: ${row}`);
    assert.equal(shown + Number(dropped?.[1] ?? 0), 6, `width ${width}: ${row}`);
  }
});

test("a width too small to lay a row out at all is ignored rather than obeyed", () => {
  assert.equal(render(WIDE, { width: 0 }), render(WIDE));
  assert.equal(render(WIDE, { width: 19 }), render(WIDE));
  assert.notEqual(render(WIDE, { width: 20 }), render(WIDE));
});

test("a title of astral characters is measured and cut by column, never mid-pair", () => {
  const whole = "\u{1F680}".repeat(22);
  const kept = rowFor(render(titled(whole), { width: 80 }), "sr-1");
  assert.ok(kept.includes(whole), kept);
  assert.doesNotMatch(kept, /\u2026/);
  assert.equal(displayWidth(kept), 80);
  const cut = rowFor(render(titled("\u{1F680}".repeat(60)), { width: 80 }), "sr-1");
  assert.doesNotMatch(cut, LONE_SURROGATE);
  assert.ok(displayWidth(cut) <= 80, `${displayWidth(cut)} columns: ${cut}`);
});

test("a wide title is cut to the columns it occupies, not the characters it holds", () => {
  const title = "\u4F9D\u983C\u95A2\u4FC2".repeat(30);
  assert.equal(
    rowFor(render(titled(title), { width: 80 }), "sr-1"),
    `${WIDE_ROW_PREFIX}${title.slice(0, 21)}\u2026`,
  );
  assert.equal(
    rowFor(render(titled(title), { width: 81 }), "sr-1"),
    `${WIDE_ROW_PREFIX}${title.slice(0, 22)}\u2026`,
  );
});

test("every line of a wide-glyph screen stays inside the terminal it was given", () => {
  for (const title of ["\u4F9D\u983C\u95A2\u4FC2".repeat(30), "\u{1F680}".repeat(60)]) {
    for (const width of [80, 81, 61, 45, 43]) {
      const out = render(titled(title), { width });
      for (const line of out.split("\n")) {
        assert.ok(displayWidth(line) <= width, `width ${width}: ${displayWidth(line)} columns: ${line}`);
      }
    }
  }
});

test("an ambiguous-width code point is given a stated column rather than the narrow default", () => {
  assert.equal(eastAsianWidth(0x00b1), "ambiguous");
  assert.equal(eastAsianWidth(0x4f9d), "wide");
  assert.equal(eastAsianWidth(0x1f680), "wide");
  assert.equal(eastAsianWidth(0x0061), "narrow");
  const title = "\u00b1".repeat(44);
  const row = rowFor(render(titled(title), { width: 80 }), "sr-1");
  assert.ok(row.endsWith(title), row);
  assert.equal(displayWidth(row), 80);
});

test("an aged snapshot says how old it is rather than reading as the present", () => {
  const out = render(BUSY, { now: NOW + 25 * 60_000 });
  const head = lineAt(out, 0);
  const second = lineAt(out, 1);
  assert.match(head, /pitwall · 2 projects · 25m ago · 2026-09-08T14:11:00Z/);
  assert.match(second, /^STALE 25m old · run pitwall snapshot to refresh$/);
  assert.match(out, /^RUNNING 1 working · 1 awaiting lander · as of 25m ago$/m);
});

test("a snapshot taken moments ago carries its age quietly and is not called stale", () => {
  const out = render(BUSY, { now: NOW + 30_000 });
  assert.match(lineAt(out, 0), /pitwall · 2 projects · <1m ago · /);
  assert.doesNotMatch(out, /STALE/);
  assert.match(out, /^RUNNING 1 working · 1 awaiting lander$/m);
});

test("the stale threshold is a boundary, and the running qualifier starts a minute in", () => {
  const almost = render(BUSY, { now: NOW + SNAPSHOT_STALE_AFTER_MS - 1 });
  assert.doesNotMatch(almost, /STALE/);
  assert.match(almost, /RUNNING 1 working · 1 awaiting lander · as of 9m ago/);
  const over = render(BUSY, { now: NOW + SNAPSHOT_STALE_AFTER_MS });
  assert.match(over, /^STALE 10m old/m);
  assert.match(over, /as of 10m ago/);
  assert.match(render(BUSY, { now: NOW + 59_999 }), /^RUNNING 1 working · 1 awaiting lander$/m);
});

test("the terminal calls a snapshot stale at the same age the console does", () => {
  assert.equal(SNAPSHOT_STALE_AFTER_MS, 10 * 60_000);
});

test("a file read with --from is still called stale but is not told to run a command that would not touch it", () => {
  const aged = { now: NOW + 25 * 60_000 };
  assert.match(lineAt(render(BUSY, aged), 1), /^STALE 25m old · run pitwall snapshot to refresh$/);
  const given = render(BUSY, { ...aged, fromFile: true });
  assert.match(lineAt(given, 1), /^STALE 25m old$/);
  assert.doesNotMatch(given, /refresh/);
  assert.match(given, /as of 25m ago/);
});

test("a narrow terminal keeps the age and drops the timestamp whole rather than cutting it", () => {
  for (const width of [43, 40, 36, 35]) {
    const out = render(WIDE, { width, now: NOW + 25 * 60_000 });
    const band = out.slice(0, out.indexOf("PROBLEMS"));
    for (const line of band.split("\n")) {
      assert.ok(line.length <= width, `width ${width}: ${line.length} columns: ${line}`);
    }
    const head = lineAt(out, 0);
    assert.match(head, /25m ago/);
    assert.ok(head.includes(GENERATED_AT) || !head.includes("2026-"), head);
    assert.doesNotMatch(head, / · $/);
    assert.match(lineAt(out, 1), /^STALE 25m old/);
  }
});

test("a stale screen in colour says the same words as the plain one", () => {
  const aged = { now: NOW + 25 * 60_000 };
  const plain = render(BUSY, aged);
  const coloured = render(BUSY, { ...aged, color: true });
  assert.match(coloured, ESCAPE);
  assert.equal(coloured.replace(new RegExp(`${ESCAPE.source}[0-9;]*m`, "g"), ""), plain);
});

test("an age that cannot be worked out is left off, and a clock behind the snapshot is not a negative age", () => {
  const undated = render({ ...BUSY, generatedAt: "whenever" }, { now: NOW + 25 * 60_000 });
  assert.equal(lineAt(undated, 0), "pitwall · 2 projects · whenever");
  assert.doesNotMatch(undated, /STALE|ago/);
  const skewed = render(BUSY, { now: NOW - 60 * 60_000 });
  assert.match(lineAt(skewed, 0), /<1m ago/);
  assert.doesNotMatch(lineAt(skewed, 0), /-\d+[mhd] ago/);
  assert.doesNotMatch(skewed, /STALE/);
});

test("a snapshot that is missing reads differently from one that is merely old", () => {
  const absent = missingSnapshotMessage({ source: "/state/snapshot.json", message: "ENOENT", at: GENERATED_AT });
  assert.match(absent, /^No snapshot to show yet - \/state\/snapshot\.json could not be read: ENOENT$/);
  assert.doesNotMatch(absent, /STALE|ago/);
  assert.match(render(BUSY, { now: NOW + 25 * 60_000 }), /STALE/);
});
