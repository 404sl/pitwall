import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Issue } from "@404sl/pitwall-schema";
import type { IssueText } from "../src/beads.ts";
import type { ProjectParks } from "../src/board.ts";
import { parkLabelOf } from "../src/classify.ts";
import { consolePath, parksFor, questionOf, readConsoleState, writeConsoleState } from "../src/parks.ts";

const FIRST = "2026-09-08T09:00:00.000Z";
const SECOND = "2026-09-08T09:30:00.000Z";

function issue(id: string, classification: string, labels: string[] = [], title = `title for ${id}`): Issue {
  return Issue.parse({ id, title, status: "open", labels, classification });
}

function texts(entries: Record<string, Partial<IssueText>>): Map<string, IssueText> {
  return new Map(
    Object.entries(entries).map(([id, text]) => [id, { description: text.description, notes: text.notes }]),
  );
}

test("a park is dated from the collection that first saw it and carried while its label holds", () => {
  const issues = [issue("mw-1", "yours:decision", ["needs-decision"]), issue("mw-2", "parked:tooling", ["blocked-tooling"])];
  const first = parksFor(issues, texts({}), undefined, FIRST);
  assert.deepEqual(first, {
    "mw-1": { label: "needs-decision", parkedSince: FIRST, basis: "first-seen" },
    "mw-2": { label: "blocked-tooling", parkedSince: FIRST, basis: "first-seen" },
  });
  const second = parksFor(issues, texts({}), first, SECOND);
  assert.deepEqual(second, {
    "mw-1": { label: "needs-decision", parkedSince: FIRST, basis: "carried" },
    "mw-2": { label: "blocked-tooling", parkedSince: FIRST, basis: "carried" },
  });
});

test("a park whose label changed starts again, and one that was lifted leaves the store", () => {
  const before: ProjectParks = {
    "mw-1": { label: "needs-decision", parkedSince: FIRST, basis: "carried" },
    "mw-2": { label: "blocked-tooling", parkedSince: FIRST, basis: "carried" },
  };
  const now = parksFor(
    [issue("mw-1", "yours:access", ["needs-access"]), issue("mw-2", "ready", [])],
    texts({}),
    before,
    SECOND,
  );
  assert.deepEqual(now, { "mw-1": { label: "needs-access", parkedSince: SECOND, basis: "first-seen" } });
});

test("only a park a label put on is aged; a structural one has no label to expire", () => {
  const structural = [
    issue("mw-3", "parked:umbrella", []),
    issue("mw-4", "blocked", []),
    issue("mw-5", "parked:umbrella", ["umbrella"]),
  ];
  assert.equal(parkLabelOf(structural[0]!), undefined);
  assert.equal(parkLabelOf(structural[1]!), undefined);
  assert.equal(parkLabelOf(structural[2]!), "umbrella");
  assert.deepEqual(Object.keys(parksFor(structural, texts({}), undefined, FIRST)), ["mw-5"]);
  assert.equal(parkLabelOf({ classification: "yours:decision", labels: ["needs-access"] }), undefined);
  assert.equal(parkLabelOf({ classification: "ready", labels: ["needs-decision"] }), undefined);
});

test("a decision states its question in one line ending in a question mark, title first", () => {
  assert.equal(questionOf({ title: "Honour the paid checkout?" }), "Honour the paid checkout?");
  assert.equal(
    questionOf({
      title: "Checkout",
      notes: "Which wording?\n\n2026-09-10T00:41:03Z lane-mw-1\nContext first.\nKeep the short one or the long one?",
    }),
    "Keep the short one or the long one?",
  );
  assert.equal(
    questionOf({ title: "Checkout", notes: "No question here.", description: "Do we honour it?\nMore text." }),
    "Do we honour it?",
  );
  assert.equal(
    questionOf({ title: "Checkout", notes: "2026-09-10T00:41:03Z lane-mw-1?\nSettled." }),
    undefined,
    "a stamp line is not a question, whatever it ends in",
  );
  assert.equal(questionOf({ title: "Checkout", description: "Nothing asked." }), undefined);
  assert.equal(
    questionOf({ title: "Checkout", notes: "Earlier: which one?\n\nLater note, no question." }),
    undefined,
    "only the newest note is read; an older question is not the one being waited on",
  );
});

test("the question is recorded for a decision only, from the texts the collection read", () => {
  const parks = parksFor(
    [issue("mw-1", "yours:decision", ["needs-decision"], "Checkout"), issue("mw-2", "yours:access", ["needs-access"], "Why?")],
    texts({ "mw-1": { description: "Honour the paid checkout?" } }),
    undefined,
    FIRST,
  );
  assert.equal(parks["mw-1"]?.question, "Honour the paid checkout?");
  assert.equal(parks["mw-2"]?.question, undefined);
});

test("the console state is written beside the snapshot and read back whole", () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-parks-"));
  const options = { env: { XDG_STATE_HOME: home } };
  assert.equal(consolePath(options), join(home, "pitwall", "console.json"));
  const absent = readConsoleState(options);
  assert.deepEqual(absent.state, { parks: {} });
  assert.equal(absent.error, undefined, "a store that has never been written is not a failure");
  const state = {
    parks: { mw: { "mw-1": { label: "needs-decision", parkedSince: FIRST, basis: "first-seen" as const, question: "Why?" } } },
  };
  writeConsoleState(state, options);
  assert.deepEqual(readConsoleState(options).state, state);
});

test("a store that cannot be read is reported and counts as empty, never as a crash", () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-parks-"));
  const options = { env: { XDG_STATE_HOME: home } };
  const path = consolePath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ not json");
  const read = readConsoleState(options);
  assert.deepEqual(read.state, { parks: {} });
  assert.equal(read.error?.source, path);
  writeFileSync(
    path,
    JSON.stringify({ parks: { mw: { "mw-1": { label: "needs-decision", parkedSince: "yesterday", basis: "first-seen" }, "mw-2": { label: 3 }, "mw-3": { label: "watch", parkedSince: FIRST, basis: "carried" } } } }),
  );
  assert.deepEqual(readConsoleState(options).state, {
    parks: { mw: { "mw-3": { label: "watch", parkedSince: FIRST, basis: "carried" } } },
  });
  assert.ok(readFileSync(path, "utf8").includes("yesterday"), "reading never rewrites the file");
});
