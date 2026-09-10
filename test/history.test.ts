import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, parseSnapshot, type Snapshot } from "@404sl/pitwall-schema";
import { DEFAULT_LIMITS, STORE_VERSION, historyPath, recordSnapshot } from "../src/history.ts";
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

function inside<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new sqlite!.DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function frames(path: string): (string | null)[] {
  return inside(path, (db) =>
    (db.prepare("SELECT frame FROM snapshots ORDER BY id ASC").all() as unknown as {
      frame: string | null;
    }[]).map((row) => row.frame),
  );
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
  assert.equal(metrics?.bounceRate, undefined);
});

test("a second reading is what turns a bounce rate into a number", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  await record(home, env, document(at(60), [{ id: "mw-1", status: "in_progress" }]), DEFAULT_LIMITS, new Date(at(60)));
  const second = await record(
    home,
    env,
    document(at(0), [{ id: "mw-1", status: "in_progress" }]),
    DEFAULT_LIMITS,
    NOW,
  );
  assert.equal(second.metrics.get("mw")?.bounceRate, 0);
});

test("a Node without node:sqlite loses the metrics and reports nothing", { skip: withoutSqlite }, () => {
  const { home, env } = place();
  const source = fileURLToPath(new URL("../src/history.ts", import.meta.url));
  const probe = [
    `const { recordSnapshot } = await import(${JSON.stringify(source)});`,
    `const result = await recordSnapshot(${JSON.stringify(document(at(0), []))}, { env: ${JSON.stringify(env)}, home: ${JSON.stringify(home)} });`,
    "console.log(JSON.stringify({ error: result.error ?? null, metrics: result.metrics.size }));",
  ].join("\n");
  const run = spawnSync(
    process.execPath,
    ["--no-experimental-sqlite", "--import", "tsx", "--input-type=module", "-e", probe],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { error: null, metrics: 0 });
});

test("the window is read a snapshot at a time rather than held whole", { skip: withoutSqlite }, (t) => {
  const { home, env } = place();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../src/history.ts", import.meta.url));
  const stamps = Array.from({ length: 120 }, (_, index) => at(300 - index * 2));
  const probe = [
    `const { DatabaseSync } = await import("node:sqlite");`,
    `const { mkdirSync } = await import("node:fs");`,
    `const { dirname } = await import("node:path");`,
    `const { recordSnapshot, historyPath } = await import(${JSON.stringify(source)});`,
    `const env = ${JSON.stringify(env)};`,
    `const home = ${JSON.stringify(home)};`,
    `const path = historyPath({ env, home });`,
    `mkdirSync(dirname(path), { recursive: true });`,
    `const db = new DatabaseSync(path);`,
    `db.exec("CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, generated_at TEXT NOT NULL, document TEXT NOT NULL)");`,
    `const insert = db.prepare("INSERT INTO snapshots (schema_version, generated_at, document) VALUES (?, ?, ?)");`,
    `const bulk = "x".repeat(500_000);`,
    `for (const stamp of ${JSON.stringify(stamps)}) {`,
    `  const held = { schemaVersion: ${JSON.stringify(SCHEMA_VERSION)}, generatedAt: stamp, projects: [{ id: "mw", issues: [{ id: "mw-1", title: bulk, status: "in_progress" }], errors: [] }], errors: [] };`,
    `  insert.run(${JSON.stringify(SCHEMA_VERSION)}, stamp, JSON.stringify(held));`,
    `}`,
    `db.close();`,
    `const result = await recordSnapshot(${JSON.stringify(document(at(0), []))}, { env, home, now: new Date(${JSON.stringify(NOW.toISOString())}) });`,
    `console.log(JSON.stringify({ error: result.error ?? null, metrics: result.metrics.get("mw") }));`,
  ].join("\n");
  const run = spawnSync(
    process.execPath,
    ["--max-old-space-size=48", "--import", "tsx", "--input-type=module", "-e", probe],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `a 60MB window did not derive inside a 48MB heap: ${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    error: null,
    metrics: {
      landedToday: 1,
      closedToday: 1,
      medianTimeToLandMinutes: 300,
      bounceRate: 0,
    },
  });
});

test("the window derives off the frames and reads a document only where one is missing", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const readings: readonly [string, Observed[]][] = [
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
  ];
  for (const [generatedAt, issues] of readings) {
    await record(home, env, document(generatedAt, issues), DEFAULT_LIMITS, new Date(generatedAt));
  }
  const path = historyPath({ env, home });
  inside(path, (db) => {
    db.exec("UPDATE snapshots SET frame = NULL WHERE id = 1");
    db.exec("UPDATE snapshots SET document = 'not a document' WHERE id > 1");
  });
  const last = await record(home, env, document(at(0), [{ id: "mw-2", status: "open" }]), DEFAULT_LIMITS, new Date(at(0)));
  const metrics = last.metrics.get("mw");
  assert.equal(last.error, undefined);
  assert.equal(metrics?.landedToday, 2);
  assert.equal(metrics?.closedToday, 2);
  assert.equal(metrics?.medianTimeToLandMinutes, 840);
  assert.equal(metrics?.bounceRate, 1 / 3);
});

test("a store written before the frame column gains it and still derives across both", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const path = historyPath({ env, home });
  mkdirSync(dirname(path), { recursive: true });
  inside(path, (db) => {
    db.exec(
      "CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, generated_at TEXT NOT NULL, document TEXT NOT NULL)",
    );
    const insert = db.prepare(
      "INSERT INTO snapshots (schema_version, generated_at, document) VALUES (?, ?, ?)",
    );
    for (const minutes of [120, 60]) {
      const held = document(at(minutes), [{ id: "mw-1", status: "in_progress" }]);
      insert.run(SCHEMA_VERSION, at(minutes), JSON.stringify(held));
    }
  });
  const last = await record(home, env, document(at(0), []), DEFAULT_LIMITS, NOW);
  const metrics = last.metrics.get("mw");
  assert.equal(last.error, undefined);
  assert.equal(metrics?.landedToday, 1);
  assert.equal(metrics?.closedToday, 1);
  assert.equal(metrics?.medianTimeToLandMinutes, 120);
  assert.deepEqual(frames(path).slice(0, 2), [null, null]);
  assert.equal(JSON.parse(frames(path)[2] as string).projects[0].id, "mw");
  assert.equal(
    inside(path, (db) => (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version),
    STORE_VERSION,
  );
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
  const limits = { maxSnapshots: 3, maxAgeDays: 30, minIntervalMinutes: 10 };
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

test("a bound the store cannot hold is floored rather than refused", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const limits = { maxSnapshots: 2.5, maxAgeDays: 30, minIntervalMinutes: 10 };
  for (const minutes of [30, 20, 10, 0]) {
    await record(home, env, document(at(minutes), []), limits, new Date(at(minutes)));
  }
  const rows = stored(historyPath({ env, home }));
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(10), at(0)],
  );
});

test("a row older than the age bound does not survive the next write", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const limits = { ...DEFAULT_LIMITS, maxAgeDays: 30 };
  const ancient = at(40 * 24 * 60);
  await record(home, env, document(ancient, []), limits, new Date(ancient));
  await record(home, env, document(at(0), []), limits, NOW);
  const rows = stored(historyPath({ env, home }));
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(0)],
  );
});

test("watching the board does not outpace the window the metrics are derived from", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  for (const minutes of [120, 119, 118, 60]) {
    await record(
      home,
      env,
      document(at(minutes), [{ id: "mw-1", status: "in_progress" }]),
      DEFAULT_LIMITS,
      new Date(at(minutes)),
    );
  }
  const rows = stored(historyPath({ env, home }));
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(120), at(60)],
  );
});

test("the interval runs from the last row written, and a write it skips is not a failure", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  await record(
    home,
    env,
    document(at(120), [{ id: "mw-1", status: "in_progress" }]),
    DEFAULT_LIMITS,
    new Date(at(120)),
  );
  const skipped = await record(
    home,
    env,
    document(at(90), [{ id: "mw-1", status: "in_progress" }]),
    DEFAULT_LIMITS,
    new Date(at(90)),
  );
  assert.equal(skipped.error, undefined);
  assert.equal(skipped.metrics.get("mw")?.landedToday, 0);
  await record(
    home,
    env,
    document(at(59), [{ id: "mw-1", status: "in_progress" }]),
    DEFAULT_LIMITS,
    new Date(at(59)),
  );
  const rows = stored(historyPath({ env, home }));
  assert.deepEqual(
    rows.map((row) => row.generated_at),
    [at(120), at(59)],
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

test("a store that cannot be written degrades rather than throwing", { skip: withoutSqlite }, async () => {
  const { home, env } = place();
  const path = historyPath({ env, home });
  mkdirSync(dirname(dirname(path)), { recursive: true });
  writeFileSync(dirname(path), "not a directory");
  const result = await record(home, env, document(at(0), []));
  assert.equal(result.metrics.size, 0);
  assert.equal(result.error?.source, path);
});
