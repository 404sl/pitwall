import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Issue, type CollectionError, type Lane } from "@404sl/pitwall-schema";
import { readIssues } from "../src/beads.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd");
const TRACKER = join(FIXTURES, "tracker");

function env(bin: string): Record<string, string> {
  return { PATH: `${join(FIXTURES, bin)}:/usr/bin:/bin` };
}

function byIdOf(collected: Awaited<ReturnType<typeof readIssues>>): Map<string, Issue> {
  return new Map(collected.issues.map((issue) => [issue.id, issue]));
}

const NO_BD = { PATH: TRACKER };

test("every issue the tracker reports is one the contract accepts", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  assert.deepEqual(collected.errors, []);
  assert.equal(collected.issues.length, 15);
  for (const issue of collected.issues) {
    assert.doesNotThrow(() => Issue.parse(issue));
  }
});

test("closed issues are kept for the metrics and never carried in issues", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  assert.deepEqual(
    collected.issues.map((issue) => issue.id).filter((id) => id === "mw-4" || id === "mw-9"),
    [],
  );
  assert.deepEqual(
    collected.closed.map((issue) => issue.id),
    ["mw-4", "mw-9"],
  );
});

test("dependency edges from bd blocked populate blockedBy", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-1.1")?.blockedBy, ["mw-2"]);
  assert.deepEqual(byId.get("mw-6")?.blockedBy, ["mw-9"]);
  assert.deepEqual(byId.get("mw-5")?.blockedBy, []);
});

test("every stored status the tracker reports reaches the snapshot", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = byIdOf(collected);
  assert.deepEqual(
    ["mw-7", "mw-10", "mw-11", "mw-12", "mw-14", "mw-15"].filter((id) => !byId.has(id)),
    [],
  );
  assert.deepEqual(collected.errors, []);
});

test("a pinned issue is open and parked rather than a queue item", async () => {
  const byId = byIdOf(await readIssues(TRACKER, { env: env("ok"), errors: [] }));
  assert.equal(byId.get("mw-11")?.status, "open");
  assert.equal(byId.get("mw-11")?.classification, "parked:watch");
});

test("a hooked issue is something else working, not an empty slot", async () => {
  const byId = byIdOf(await readIssues(TRACKER, { env: env("ok"), errors: [] }));
  assert.equal(byId.get("mw-12")?.status, "in_progress");
  assert.equal(byId.get("mw-12")?.classification, "landing");
});

test("an issue whose only blocker is hooked is blocked, never ready", async () => {
  const byId = byIdOf(await readIssues(TRACKER, { env: env("ok"), errors: [] }));
  assert.deepEqual(byId.get("mw-13")?.blockedBy, ["mw-12"]);
  assert.equal(byId.get("mw-13")?.classification, "blocked");
});

test("a status bd reports only as a custom one is mapped by its category", async () => {
  const byId = byIdOf(await readIssues(TRACKER, { env: env("ok"), errors: [] }));
  assert.equal(byId.get("mw-14")?.status, "in_progress");
  assert.equal(byId.get("mw-14")?.classification, "landing");
  assert.equal(byId.get("mw-15")?.status, "open");
  assert.equal(byId.get("mw-15")?.classification, "parked:roadmap");
});

test("a status bd does not report at all is a CollectionError naming it, not a dropped issue", async () => {
  const collected = await readIssues(TRACKER, {
    env: { ...env("ok"), BD_LIST_FIXTURE: "unmapped" },
    errors: [],
  });
  assert.deepEqual(collected.issues, []);
  assert.deepEqual(collected.closed, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd list --all --limit 0 --json: /);
  assert.match(collected.errors[0]?.message ?? "", /mw-16/);
  assert.match(collected.errors[0]?.message ?? "", /quarantined/);
});

test("an issue the tracker stores as blocked or deferred is still part of the backlog", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-7")?.status, "open");
  assert.equal(byId.get("mw-10")?.status, "open");
  assert.equal(byId.get("mw-7")?.classification, "blocked");
  assert.equal(byId.get("mw-10")?.classification, "parked:roadmap");
});

test("a stored blocked status holds even when every dependency edge has closed", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-8")?.blockedBy, ["mw-9"]);
  assert.equal(byId.get("mw-8")?.classification, "blocked");
});

test("an edge onto an issue the tracker stores as blocked is a blocker like any other", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-4.2")?.classification, "blocked");
});

test("an edge onto an open blocker is blocked and one onto a closed blocker is not", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-1.1")?.classification, "blocked");
  assert.equal(byId.get("mw-6")?.classification, "ready");
});

const ALREADY_FAILED: CollectionError[] = [
  { source: "/workspace/.autofix.json", message: "lanes could not be read", at: "2026-09-08T14:00:00Z" },
];

test("a blocker missing from a clean collection still reads as closed", async () => {
  const collected = await readIssues(TRACKER, {
    env: { ...env("ok"), BD_LIST_FIXTURE: "partial" },
    errors: [],
  });
  const byId = byIdOf(collected);
  assert.deepEqual(collected.errors, []);
  assert.deepEqual(byId.get("mw-6")?.blockedBy, ["mw-9"]);
  assert.equal(byId.get("mw-6")?.classification, "ready");
});

test("a blocker missing from an incomplete collection is blocking, not closed", async () => {
  const byId = byIdOf(
    await readIssues(TRACKER, {
      env: { ...env("ok"), BD_LIST_FIXTURE: "partial" },
      errors: ALREADY_FAILED,
    }),
  );
  assert.equal(byId.get("mw-6")?.classification, "blocked");
  assert.equal(byId.get("mw-5")?.classification, "ready");
});

test("an incomplete collection does not block an edge onto a blocker it did carry as closed", async () => {
  const byId = byIdOf(await readIssues(TRACKER, { env: env("ok"), errors: ALREADY_FAILED }));
  assert.equal(byId.get("mw-6")?.classification, "ready");
});

test("classification runs over the collected issues", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-3")?.classification, "yours:decision");
  assert.equal(byId.get("mw-5")?.classification, "ready");
  assert.equal(byId.get("mw-2")?.classification, "landing");
});

test("a lane working on an in-progress issue makes it in-flight rather than landing", async () => {
  const lanes: Lane[] = [{ slot: 1, state: "working", executor: "local", issueId: "mw-2" }];
  const collected = await readIssues(TRACKER, { env: env("ok"), lanes, errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-2")?.classification, "in-flight");
});

test("an issue carries the origin its own metadata records", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-1")?.origin, { session: "mw-planning-session", ref: "c1796a" });
});

test("a child with no metadata inherits the origin of its nearest ancestor", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-1.1")?.origin, { session: "mw-planning-session", ref: "c1796a" });
});

test("an ancestor that is closed still supplies the origin", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-4.2")?.origin, { session: "mw-replay-session", ref: "41ba07" });
});

test("an issue with no origin anywhere up the chain is not an error", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const byId = new Map(collected.issues.map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-5")?.origin, undefined);
  assert.deepEqual(collected.errors, []);
});

test("bd fields map onto the contract's names", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
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

test("a null labels field becomes an empty list rather than a parse failure", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  assert.deepEqual(collected.issues.find((issue) => issue.id === "mw-5")?.labels, []);
});

test("bd is asked about the tracker under the given root, not the working directory", async () => {
  const elsewhere = await readIssues(join(FIXTURES, "no-such-workspace"), { env: env("ok"), errors: [] });
  assert.deepEqual(elsewhere.issues, []);
  assert.equal(elsewhere.errors.length, 1);
  assert.equal(elsewhere.errors[0]?.source, join(FIXTURES, "no-such-workspace", ".beads"));
});

test("a bd that is not installed is a CollectionError naming the command", async () => {
  const collected = await readIssues(TRACKER, { env: NO_BD, errors: [] });
  assert.deepEqual(collected.issues, []);
  assert.deepEqual(collected.closed, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd statuses --json: /);
  assert.match(collected.errors[0]?.message ?? "", /ENOENT/);
});

test("a bd that exits non-zero is a CollectionError naming the command", async () => {
  const collected = await readIssues(TRACKER, { env: env("failing"), errors: [] });
  assert.deepEqual(collected.issues, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd statuses --json: /);
  assert.match(collected.errors[0]?.message ?? "", /no beads database found/);
});

test("a bd that prints something other than JSON is a CollectionError naming the command", async () => {
  const collected = await readIssues(TRACKER, { env: env("garbage"), errors: [] });
  assert.deepEqual(collected.issues, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd statuses --json: /);
  assert.match(collected.errors[0]?.message ?? "", /JSON|not an array/);
});

test("a bd that hangs is a CollectionError naming the command rather than a stuck read", async () => {
  const collected = await readIssues(TRACKER, { env: env("slow"), timeoutMs: 200, errors: [] });
  assert.deepEqual(collected.issues, []);
  assert.deepEqual(collected.closed, []);
  assert.equal(collected.errors.length, 1);
  assert.match(collected.errors[0]?.message ?? "", /^bd statuses --json: /);
  assert.match(collected.errors[0]?.message ?? "", /timed out after 200ms/);
});

test("a failure carries a timestamp and a source the contract accepts", async () => {
  const collected = await readIssues(TRACKER, { env: env("failing"), errors: [] });
  const error = collected.errors[0];
  assert.equal(error?.source, join(TRACKER, ".beads"));
  assert.match(error?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
});
