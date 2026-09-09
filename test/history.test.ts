import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION, parseSnapshot, type Snapshot } from "@404sl/pitwall-schema";
import { DEFAULT_LIMITS, historyPath, recordSnapshot } from "../src/history.ts";
import { VERSION } from "../src/version.ts";

const sqlite = await import("node:sqlite").then(
  (module) => module,
  () => undefined,
);
const withoutSqlite = sqlite === undefined;

const NOW = new Date(2026, 8, 9, 12, 0, 0);
const MINUTE_MS = 60 * 1000;

interface Observed {
  id: string;
  status: "open" | "in_progress";
}

function place(): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), "pitwall-history-"));
  return { home, env: { XDG_STATE_HOME: join(home, "state") } };
}

function at(minutesBeforeNow: number): string {
  return new Date(NOW.getTime() - minutesBeforeNow * MINUTE_MS).toISOString();
}

function document(generatedAt: string, issues: readonly Observed[], errors: string[] = []): Snapshot {
  return parseSnapshot({
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    agent: { version: VERSION },
    projects: [
      {
        id: "mw",
        name: "midwinter",
        root: "/tmp/midwinter",
        authority: { kind: "beads", idPrefix: "mw" },
        issues: issues.map((issue) => ({
          id: issue.id,
          title: issue.id,
          status: issue.status,
          classification: issue.status === "in_progress" ? "in-flight" : "ready",
        })),
        metrics: {},
        errors: errors.map((source) => ({ source, message: "unreadable", at: generatedAt })),
      },
    ],
    errors: [],
  });
}

function stored(path: string): { schema_version: string; generated_at: string }[] {
  const db = new sqlite!.DatabaseSync(path);
  try {
    return db.prepare("SELECT schema_version, generated_at FROM snapshots ORDER BY id ASC").all() as unknown as {
      schema_version: string;
      generated_at: string;
    }[];
  } finally {
    db.close();
  }
}

async function record(
  home: string,
  env: Record<string, string>,
  snapshot: Snapshot,
  limits = DEFAULT_LIMITS,
  now?: Date,
) {
  return recordSnapshot(snapshot, { env, home, limits, now });
}

test("the store lives under the state path and honours XDG_STATE_HOME", () => {
  assert.equal(
    historyPath({ env: {}, home: "/home/nobody" }),
    join("/home/nobody", ".local", "state", "pitwall", "history.db"),
  );
  assert.equal(
    historyPath({ env: { XDG_STATE_HOME: "/elsewhere" } }),
    join("/elsewhere", "pitwall", "history.db"),
  );
});

test("each snapshot is appended with the contract version it speaks", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const first = await record(home, env, document(at(60), [{ id: "mw-1", status: "open" }]));
  assert.equal(first.error, undefined);
  assert.equal(first.path, historyPath({ env, home }));
  await record(home, env, document(at(0), [{ id: "mw-1", status: "in_progress" }]));
  const rows = stored(first.path);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.schema_version),
    [SCHEMA_VERSION, SCHEMA_VERSION],
  );
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(60), at(0)],
  );
});

test("throughput, time to land and bounce rate come off the stored snapshots", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const frames: readonly [string, Observed[]][] = [
    [
      at(1560),
      [
        { id: "mw-1", status: "open" },
        { id: "mw-2", status: "open" },
        { id: "mw-3", status: "in_progress" },
      ],
    ],
    [
      at(180),
      [
        { id: "mw-1", status: "in_progress" },
        { id: "mw-2", status: "open" },
        { id: "mw-3", status: "in_progress" },
      ],
    ],
    [
      at(60),
      [
        { id: "mw-2", status: "in_progress" },
        { id: "mw-3", status: "in_progress" },
      ],
    ],
    [at(0), [{ id: "mw-2", status: "open" }]],
  ];
  let last;
  for (const [generatedAt, issues] of frames) {
    last = await record(home, env, document(generatedAt, issues), DEFAULT_LIMITS, new Date(generatedAt));
  }
  const metrics = last?.metrics.get("mw");
  assert.equal(last?.error, undefined);
  assert.equal(metrics?.landedToday, 2);
  assert.equal(metrics?.closedToday, 2);
  assert.equal(metrics?.medianTimeToLandMinutes, 840);
  assert.equal(metrics?.bounceRate, 1 / 3);
});

test("a single snapshot answers nothing it cannot see", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const only = await record(
    home,
    env,
    document(at(0), [{ id: "mw-1", status: "in_progress" }]),
    DEFAULT_LIMITS,
    NOW,
  );
  const metrics = only.metrics.get("mw");
  assert.equal(metrics?.landedToday, 0);
  assert.equal(metrics?.medianTimeToLandMinutes, undefined);
  assert.equal(metrics?.bounceRate, 0);
});

test("a snapshot that could not read a project is not read as everything closing", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  await record(
    home,
    env,
    document(at(60), [{ id: "mw-1", status: "in_progress" }]),
    DEFAULT_LIMITS,
    new Date(at(60)),
  );
  const blind = await record(home, env, document(at(0), [], ["/tmp/midwinter/.beads"]), DEFAULT_LIMITS, NOW);
  assert.equal(blind.metrics.get("mw")?.closedToday, 0);
});

test("writing past the bound prunes the oldest rows rather than growing", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const limits = { maxSnapshots: 3, maxAgeDays: 30 };
  for (const minutes of [50, 40, 30, 20, 10, 0]) {
    await record(home, env, document(at(minutes), []), limits, new Date(at(minutes)));
  }
  const rows = stored(historyPath({ env, home }));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(20), at(10), at(0)],
  );
});

test("a row older than the age bound does not survive the next write", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const limits = { maxSnapshots: DEFAULT_LIMITS.maxSnapshots, maxAgeDays: 30 };
  const ancient = at(40 * 24 * 60);
  await record(home, env, document(ancient, []), limits, new Date(ancient));
  await record(home, env, document(at(0), []), limits, NOW);
  const rows = stored(historyPath({ env, home }));
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(0)],
  );
});

test("a corrupt store reports the failure and answers no history metrics", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const path = historyPath({ env, home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "this is not a database");
  const result = await record(home, env, document(at(0), []));
  assert.equal(result.path, path);
  assert.equal(result.metrics.size, 0);
  assert.equal(result.error?.source, path);
  assert.ok((result.error?.message ?? "") !== "");
});

test("a store that cannot be written degrades rather than throwing", async () => {
  const { home, env } = place();
  const path = historyPath({ env, home });
  mkdirSync(dirname(dirname(path)), { recursive: true });
  writeFileSync(dirname(path), "not a directory");
  const result = await record(home, env, document(at(0), []));
  assert.equal(result.metrics.size, 0);
  assert.equal(result.error?.source, path);
});
