import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Issue, type Lane } from "@404sl/pitwall-schema";
import { readIssues } from "../src/beads.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd");
const TRACKER = join(FIXTURES, "tracker");

function env(bin: string): Record<string, string> {
  return { PATH: `${join(FIXTURES, bin)}:/usr/bin:/bin` };
}

const NO_BD = { PATH: TRACKER };

test("every issue the tracker reports is one the contract accepts", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  assert.deepEqual(collected.errors, []);
  assert.equal(collected.issues.length, 7);
  for (const issue of collected.issues) {
    assert.doesNotThrow(() => Issue.parse(issue));
  }
});

test("closed issues are kept for the metrics and never carried in issues", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  assert.deepEqual(
    collected.issues.map((issue) => issue.id).filter((id) => id === "mw-4" || id === "mw-9"),
    [],
  );
  assert.deepEqual(
    collected.closed.map((issue) => issue.id),
    ["mw-4", "mw-9"],
  );
});

test("dependency edges from bd blocked populate blockedBy", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-1.1")?.blockedBy, ["mw-2"]);
  assert.deepEqual(byId.get("mw-6")?.blockedBy, ["mw-9"]);
  assert.deepEqual(byId.get("mw-5")?.blockedBy, []);
});

test("an edge onto an open blocker is blocked and one onto a closed blocker is not", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-1.1")?.classification, "blocked");
  assert.equal(byId.get("mw-6")?.classification, "ready");
});

test("classification runs over the collected issues", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-3")?.classification, "yours:decision");
  assert.equal(byId.get("mw-5")?.classification, "ready");
  assert.equal(byId.get("mw-2")?.classification, "landing");
});

test("a lane working on an in-progress issue makes it in-flight rather than landing", () => {
  const lanes: Lane[] = [{ slot: 1, state: "working", executor: "local", issueId: "mw-2" }];
  const collected = readIssues(TRACKER, { env: env("ok"), lanes });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-2")?.classification, "in-flight");
});

test("an issue carries the origin its own metadata records", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-1")?.origin, { session: "mw-planning-session", ref: "c1796a" });
});

test("a child with no metadata inherits the origin of its nearest ancestor", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-1.1")?.origin, { session: "mw-planning-session", ref: "c1796a" });
});

test("an ancestor that is closed still supplies the origin", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-4.2")?.origin, { session: "mw-replay-session", ref: "41ba07" });
});

test("an issue with no origin anywhere up the chain is not an error", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-5")?.origin, undefined);
  assert.deepEqual(collected.errors, []);
});

test("bd fields map onto the contract's names", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  const decision = collected.issues.find((issue) => issue.id === "mw-3");
  assert.equal(decision?.title, "Honour the paid checkout?");
  assert.equal(decision?.status, "open");
  assert.equal(decision?.issueType, "decision");
  assert.equal(decision?.priority, 1);
  assert.deepEqual(decision?.labels, ["needs-decision"]);
  assert.equal(decision?.createdAt, "2026-09-07T09:02:11Z");
  assert.equal(decision?.updatedAt, "2026-09-08T08:14:00Z");
  assert.deepEqual(decision?.staleness, { verdict: "unchecked", evidence: [] });
});

test("a null labels field becomes an empty list rather than a parse failure", () => {
  const collected = readIssues(TRACKER, { env: env("ok") });
  assert.deepEqual(collected.issues.find((issue) => issue.id === "mw-5")?.labels, []);
});

test("bd is asked about the tracker under the given root, not the working directory", () => {
  const elsewhere = readIssues(join(FIXTURES, "no-such-workspace"), { env: env("ok") });
  assert.deepEqual(elsewhere.issues, []);
  assert.equal(elsewhere.errors.length, 1);
  assert.equal(elsewhere.errors[0]?.source, join(FIXTURES, "no-such-workspace", ".beads"));
});

test("a bd that is not installed is a CollectionError naming the command", () => {
  const collected = readIssues(TRACKER, { env: NO_BD });
  assert.deepEqual(collected.issues, []);
  assert.deepEqual(collected.closed, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd list --status open --limit 0 --json: /);
  assert.match(collected.errors[0]?.message ?? "", /ENOENT/);
});

test("a bd that exits non-zero is a CollectionError naming the command", () => {
  const collected = readIssues(TRACKER, { env: env("failing") });
  assert.deepEqual(collected.issues, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd list --status open --limit 0 --json: /);
  assert.match(collected.errors[0]?.message ?? "", /no beads database found/);
});

test("a bd that prints something other than JSON is a CollectionError naming the command", () => {
  const collected = readIssues(TRACKER, { env: env("garbage") });
  assert.deepEqual(collected.issues, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd list --status open --limit 0 --json: /);
  assert.match(collected.errors[0]?.message ?? "", /JSON|not an array/);
});

test("a failure carries a timestamp and a source the contract accepts", () => {
  const collected = readIssues(TRACKER, { env: env("failing") });
  const error = collected.errors[0];
  assert.equal(error?.source, join(TRACKER, ".beads"));
  assert.match(error?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
});
