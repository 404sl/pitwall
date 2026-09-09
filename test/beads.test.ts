import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Issue, type CollectionError, type Lane } from "@404sl/pitwall-schema";
import { appendNotesArgs, noteAppender, readIssue, readIssues, showArgs } from "../src/beads.ts";
import type { UnclassifiedIssue } from "../src/classify.ts";

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

function keysIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysIn(entry, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      keysIn(entry, found);
    }
  }
  return found;
}

test("the collected issues carry no body, however much body the tracker reports", async () => {
  const collected = await readIssues(TRACKER, { env: env("ok"), errors: [] });
  const carried = keysIn(collected.issues);
  assert.equal(carried.has("description"), false, "a description must never reach the snapshot");
  assert.equal(carried.has("notes"), false, "notes must never reach the snapshot");
  assert.equal(carried.has("acceptance_criteria"), false);
  assert.ok(carried.has("title"));
});

async function indexedIssues(fixture?: string): Promise<Issue[]> {
  const listing = fixture === undefined ? env("ok") : { ...env("ok"), BD_LIST_FIXTURE: fixture };
  return (await readIssues(TRACKER, { env: listing, errors: [] })).issues;
}

test("one issue is read with its body, and with the rule that classified it", async () => {
  const reading = await readIssue(TRACKER, "mw-1", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(reading.kind, "found");
  if (reading.kind !== "found") return;
  assert.match(reading.issue.description ?? "", /The screen this product exists to show/);
  assert.match(reading.issue.notes ?? "", /Signal colours never decorate/);
  assert.deepEqual(reading.issue.reason, { rule: "umbrella-open-child", childId: "mw-1.1" });
  assert.equal(reading.issue.classification, "parked:umbrella");
  assert.deepEqual(reading.issue.origin, { session: "mw-planning-session", ref: "c1796a" });
});

test("a dependency row is a blocking edge, never a merely related one", async () => {
  const reading = await readIssue(TRACKER, "mw-1", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(reading.kind, "found");
  if (reading.kind !== "found") return;
  assert.deepEqual(
    reading.issue.blockedBy.map((link) => [link.id, link.status]),
    [["mw-9", "closed"]],
  );
  assert.deepEqual(
    reading.issue.blocks.map((link) => [link.id, link.status]),
    [["mw-1.1", "open"]],
  );
});

test("a closed issue is read with its body and no active classification", async () => {
  const reading = await readIssue(TRACKER, "mw-9", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(reading.kind, "found");
  if (reading.kind !== "found") return;
  assert.equal(reading.issue.status, "closed");
  assert.notEqual(reading.issue.classification, "ready", "finished work must not read as ready");
  assert.equal(reading.issue.classification, undefined);
  assert.deepEqual(reading.issue.reason, { rule: "closed" });
  assert.match(reading.issue.description ?? "", /Vite, React and one stylesheet/);
  assert.deepEqual(
    reading.issue.blocks.map((link) => link.id),
    ["mw-1"],
  );
});

test("a closed umbrella is not parked either - a closed issue is parked by nothing", async () => {
  const reading = await readIssue(TRACKER, "mw-4", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(reading.kind, "found");
  if (reading.kind !== "found") return;
  assert.equal(reading.issue.classification, undefined);
  assert.deepEqual(reading.issue.reason, { rule: "closed" });
});

test("an issue the tracker does not hold is missing, not a failure to read", async () => {
  const reading = await readIssue(TRACKER, "mw-nope", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(reading.kind, "missing");
  assert.ok(reading.tried.length > 0);
});

test("an authority that cannot be read says what it ran, and does not read as absence", async () => {
  const reading = await readIssue(TRACKER, "mw-1", {
    env: env("failing"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(reading.kind, "unreadable");
  if (reading.kind !== "unreadable") return;
  assert.deepEqual(reading.tried, ["bd show --id mw-1 --json --include-dependents"]);
  assert.match(reading.error.message, /bd show --id mw-1 --json --include-dependents/);
  assert.match(reading.error.source, /\.beads$/);
});

test("the rule one issue reports is the rule the board already recorded", async () => {
  const issues = await indexedIssues();
  const recorded = new Map(issues.map((issue) => [issue.id, issue.classification]));
  for (const id of ["mw-1", "mw-3", "mw-10", "mw-15"]) {
    const reading = await readIssue(TRACKER, id, { env: env("ok"), issues, collectionComplete: true });
    assert.equal(reading.kind, "found", `${id} could not be read`);
    if (reading.kind !== "found") continue;
    assert.equal(
      reading.issue.classification,
      recorded.get(id),
      `${id} reads differently on its own page than on the board`,
    );
  }
});

function listedAs(id: string, status: UnclassifiedIssue["status"]): UnclassifiedIssue {
  return { id, title: id, status, labels: [], blockedBy: [] };
}

test("a blocker's state comes from the tracker, not from the board, in both directions", async () => {
  const open = await readIssue(TRACKER, "mw-6", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  assert.equal(open.kind, "found");
  if (open.kind !== "found") return;
  assert.deepEqual(
    open.issue.blockedBy.map((link) => [link.id, link.status]),
    [["mw-9", "open"]],
    "the tracker reports mw-9 open, and the board does not list it at all",
  );
  assert.equal(open.issue.classification, "blocked");
  assert.deepEqual(open.issue.reason, { rule: "blocked-open", ids: ["mw-9"] });

  const closed = await readIssue(TRACKER, "mw-1", {
    env: env("ok"),
    issues: [listedAs("mw-1", "open"), listedAs("mw-9", "open")],
    collectionComplete: true,
  });
  assert.equal(closed.kind, "found");
  if (closed.kind !== "found") return;
  assert.deepEqual(
    closed.issue.blockedBy.map((link) => [link.id, link.status]),
    [["mw-9", "closed"]],
    "the tracker reports mw-9 closed, and the board still carries it as open",
  );
  assert.equal(closed.issue.classification, "ready");
  assert.deepEqual(closed.issue.reason, { rule: "default" });
});

test("an umbrella's children come from the tracker, not from the board, in both directions", async () => {
  const created = await readIssue(TRACKER, "mw-5", {
    env: env("ok"),
    issues: [listedAs("mw-5", "open")],
    collectionComplete: true,
  });
  assert.equal(created.kind, "found");
  if (created.kind !== "found") return;
  assert.equal(
    created.issue.classification,
    "parked:umbrella",
    "the tracker reports mw-5.1 open, and the board does not list it at all",
  );
  assert.deepEqual(created.issue.reason, { rule: "umbrella-open-child", childId: "mw-5.1" });

  const finished = await readIssue(TRACKER, "mw-13", {
    env: env("ok"),
    issues: [listedAs("mw-13", "open"), listedAs("mw-13.1", "open")],
    collectionComplete: true,
  });
  assert.equal(finished.kind, "found");
  if (finished.kind !== "found") return;
  assert.equal(
    finished.issue.classification,
    "ready",
    "the tracker reports mw-13.1 closed while the board still carries it as open, and mw-77 is a parent-child edge outside mw-13's id, so it is not a child",
  );
  assert.deepEqual(finished.issue.reason, { rule: "default" });
});

test("a parent's state comes from the tracker, not from the board, in both directions", async () => {
  const started = await readIssue(TRACKER, "mw-4.2", {
    env: env("ok"),
    issues: [listedAs("mw-4", "closed"), listedAs("mw-4.2", "open")],
    collectionComplete: true,
  });
  assert.equal(started.kind, "found");
  if (started.kind !== "found") return;
  assert.equal(
    started.issue.classification,
    "blocked",
    "the tracker reports mw-4 in progress, and the board still carries it as closed",
  );
  assert.deepEqual(started.issue.reason, { rule: "blocked-parent-in-progress", parentId: "mw-4" });

  const done = await readIssue(TRACKER, "mw-2.1", {
    env: env("ok"),
    issues: [listedAs("mw-2", "in_progress"), listedAs("mw-2.1", "open")],
    collectionComplete: true,
  });
  assert.equal(done.kind, "found");
  if (done.kind !== "found") return;
  assert.equal(
    done.issue.classification,
    "ready",
    "the tracker reports mw-2 closed, and the board still carries it as in progress",
  );
  assert.deepEqual(done.issue.reason, { rule: "default" });
});

test("a board that could not be collected does not overrule what the tracker said", async () => {
  const closed = await readIssue(TRACKER, "mw-1", {
    env: env("ok"),
    issues: [],
    collectionComplete: false,
  });
  assert.equal(closed.kind, "found");
  if (closed.kind !== "found") return;
  assert.equal(
    closed.issue.classification,
    "ready",
    "show named mw-9 closed, so an unreadable board has nothing left to say about it",
  );
  assert.deepEqual(closed.issue.reason, { rule: "default" });

  const open = await readIssue(TRACKER, "mw-6", {
    env: env("ok"),
    issues: [],
    collectionComplete: false,
  });
  assert.equal(open.kind, "found");
  if (open.kind !== "found") return;
  assert.equal(open.issue.classification, "blocked");
  assert.deepEqual(
    open.issue.reason,
    { rule: "blocked-open", ids: ["mw-9"] },
    "an open blocker is blocked-open, never blocked-unreadable, once show has named its status",
  );
});

test("a stored status the built-in set does not name costs one extra call, and no more", async () => {
  const issues = await indexedIssues();
  const custom = await readIssue(TRACKER, "mw-15", { env: env("ok"), issues, collectionComplete: true });
  assert.equal(custom.kind, "found");
  if (custom.kind !== "found") return;
  assert.equal(custom.issue.classification, "parked:roadmap");
  assert.deepEqual(custom.issue.reason, { rule: "stored-status", status: "icebox" });
  assert.deepEqual(
    custom.issue.blocks.map((link) => [link.id, link.status]),
    [["mw-14", "in_progress"]],
  );
  assert.deepEqual(
    custom.tried.map((command) => command.split(" ")[1]),
    ["show", "statuses"],
  );

  const builtIn = await readIssue(TRACKER, "mw-10", { env: env("ok"), issues, collectionComplete: true });
  assert.deepEqual(
    builtIn.tried.map((command) => command.split(" ")[1]),
    ["show"],
    "a status the built-in set names must not send anyone back to the tracker",
  );
});

test("reading one issue runs nothing that could write to the tracker", async () => {
  const reading = await readIssue(TRACKER, "mw-1", {
    env: env("ok"),
    issues: await indexedIssues(),
    collectionComplete: true,
  });
  const ran = reading.tried.map((command) => command.split(" ")[1]);
  assert.deepEqual(ran, ["show"]);
  assert.deepEqual(showArgs("mw-1"), ["show", "--id", "mw-1", "--json", "--include-dependents"]);
});

test("an undelivered notice is appended to the issue rather than dropped", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "pitwall-notes-")), "notes.log");
  const append = noteAppender(TRACKER, { env: { ...env("ok"), BD_NOTES_LOG: log } });
  await append("mw-1", "could not be delivered to c1796a");
  assert.equal(readFileSync(log, "utf8"), "mw-1 could not be delivered to c1796a\n");
  assert.deepEqual(appendNotesArgs("mw-1", "text"), ["update", "mw-1", "--append-notes", "text"]);
});

test("a tracker that refuses the note says what it ran", async () => {
  const append = noteAppender(TRACKER, { env: env("ok") });
  await assert.rejects(
    () => append("mw-1", "could not be delivered"),
    /bd update mw-1 --append-notes: /,
  );
});
