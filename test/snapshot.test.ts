import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { SCHEMA_VERSION, isYours, parseSnapshot } from "@404sl/pitwall-schema";
import type { Notice } from "../src/notify.ts";
import { KEPT_SOURCE, PARTIAL_SOURCE, REFRESH_SOURCE, buildBoard } from "../src/board.ts";
import { consoleCollector, createConsoleServer, listen } from "../src/serve.ts";
import { collectSnapshot, emitSnapshot } from "../src/snapshot.ts";
import { historyPath } from "../src/history.ts";
import { readSnapshot, snapshotPath } from "../src/state.ts";
import { VERSION } from "../src/version.ts";

const hasSqlite = await import("node:sqlite").then(
  () => true,
  () => false,
);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TRACKER = join(FIXTURES, "bd", "tracker");
const NO_TRACKER = join(FIXTURES, "plain");
const PATH_WITH_BD = `${join(FIXTURES, "bd", "ok")}:/usr/bin:/bin`;
const PATH_WITH_GH = `${join(FIXTURES, "bd", "ok")}:${join(FIXTURES, "gh", "ok")}:/usr/bin:/bin`;
const RECORDED = join(FIXTURES, "gh", "recorded");
const PATH_WITH_UNAUTH_GH = `${join(FIXTURES, "bd", "ok")}:${join(FIXTURES, "gh", "unauth")}:/usr/bin:/bin`;

function pathWithoutGh(): string {
  const bin = mkdtempSync(join(tmpdir(), "pitwall-nogh-"));
  for (const tool of ["dirname", "cat"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    assert.equal(found.status, 0, `${tool} is not on PATH`);
    symlinkSync(found.stdout.trim(), join(bin, tool));
  }
  return `${join(FIXTURES, "bd", "ok")}:${bin}`;
}

interface Workspace {
  home: string;
  env: Record<string, string>;
  configPath: string;
}

function withConfig(contents: string): Workspace {
  const home = mkdtempSync(join(tmpdir(), "pitwall-snapshot-"));
  const configPath = join(home, ".config", "pitwall", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(join(home, "work", "here"), { recursive: true });
  writeFileSync(configPath, contents);
  return { home, configPath, env: { PATH: PATH_WITH_BD, XDG_STATE_HOME: join(home, "state") } };
}

function workspace(roots: string[]): Workspace {
  return withConfig(JSON.stringify({ roots }));
}

function degradedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-degraded-"));
  writeFileSync(join(root, ".autofix.json"), '{ "idPrefix": "degraded", "repos": {');
  cpSync(join(TRACKER, "bd-output"), join(root, "bd-output"), { recursive: true });
  return root;
}

function options(place: Workspace, now?: Date) {
  return {
    env: place.env,
    home: place.home,
    cwd: join(place.home, "work", "here"),
    lockRoot: mkdtempSync(join(tmpdir(), "pitwall-snapshot-lock-")),
    now,
  };
}

test("the assembled document is one the contract accepts", async () => {
  const place = workspace([TRACKER]);
  const at = new Date("2026-09-08T09:00:00Z");
  const snapshot = await collectSnapshot(options(place, at));
  assert.doesNotThrow(() => parseSnapshot(snapshot));
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  assert.equal(snapshot.agent.version, VERSION);
  assert.equal(snapshot.generatedAt, at.toISOString());
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0]?.issues.length, 15);
});

test("a project whose tracker cannot be read still appears and the others are unaffected", async () => {
  const place = workspace([NO_TRACKER, TRACKER]);
  const snapshot = await collectSnapshot(options(place));
  assert.deepEqual(
    snapshot.projects.map((project) => project.id),
    ["plain", "tracker"],
  );
  const unreadable = snapshot.projects[0];
  assert.equal(unreadable?.errors.length, 1);
  assert.equal(unreadable?.errors[0]?.source, join(NO_TRACKER, ".beads"));
  assert.deepEqual(unreadable?.issues, []);
  const read = snapshot.projects[1];
  assert.deepEqual(read?.errors, []);
  assert.equal(read?.issues.length, 15);
  assert.equal(read?.metrics.readyCount, 2);
});

test("inboxCount is what is yours to answer and never counts a parked issue", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot(options(place));
  const project = snapshot.projects[0];
  const issues = project?.issues ?? [];
  const parked = issues.filter((issue) => issue.classification.startsWith("parked:"));
  assert.ok(parked.length > 0);
  assert.deepEqual(
    issues.filter((issue) => isYours(issue.classification)).map((issue) => issue.id),
    ["mw-3"],
  );
  assert.equal(project?.metrics.inboxCount, 1);
  assert.equal(project?.metrics.readyCount, 2);
});

test("closedToday counts the issues closed on the day collection started", async () => {
  const place = workspace([TRACKER]);
  const onTheDay = await collectSnapshot(options(place, new Date("2026-09-04T17:20:00Z")));
  assert.equal(onTheDay.projects[0]?.metrics.closedToday, 1);
  const later = await collectSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  assert.equal(later.projects[0]?.metrics.closedToday, 0);
});

test("landedToday counts the closures of the day whose reason names a merge", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T18:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "merged" },
  });
  const metrics = snapshot.projects[0]?.metrics;
  assert.equal(metrics?.closedToday, 3);
  assert.equal(metrics?.landedToday, 2, "a closure that names no merge is closed and not landed");
  const served = await emitSnapshot({
    ...options(place, new Date("2026-09-08T18:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "merged" },
  });
  assert.equal(
    served.snapshot.projects[0]?.metrics.landedToday,
    2,
    "what the tracker measured must survive into the snapshot that is served",
  );
});

test("landedToday is absent rather than zero when a closure of the day records no reason", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T18:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "landed" },
  });
  const metrics = snapshot.projects[0]?.metrics;
  assert.equal(metrics?.closedToday, 2);
  assert.equal(metrics?.landedToday, undefined);
  const written = JSON.parse(JSON.stringify(snapshot)) as { projects: { metrics: object }[] };
  assert.equal(
    "landedToday" in (written.projects[0]?.metrics ?? {}),
    false,
    "an uncomputed figure must reach a console as absent, never as a zero it can read",
  );
  const served = await emitSnapshot({
    ...options(place, new Date("2026-09-08T18:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "landed" },
  });
  assert.equal(
    served.snapshot.projects[0]?.metrics.landedToday,
    undefined,
    "the history log must not answer a question the tracker itself left unanswered",
  );
});

test("a tracker that could not be read reports no landedToday rather than nothing landed", async () => {
  const snapshot = await collectSnapshot(options(workspace([NO_TRACKER])));
  const metrics = snapshot.projects[0]?.metrics;
  assert.ok((snapshot.projects[0]?.errors ?? []).length > 0);
  assert.equal(metrics?.closedToday, 0);
  assert.equal(metrics?.landedToday, undefined);
});

test("a project that failed to collect blocks an issue whose blocker it never saw", async () => {
  const place = workspace([degradedRoot()]);
  const snapshot = await collectSnapshot({
    ...options(place),
    env: { ...place.env, BD_LIST_FIXTURE: "partial" },
  });
  const project = snapshot.projects[0];
  const collection = (project?.errors ?? []).filter((error) => !error.source.startsWith("staleness"));
  assert.equal(collection.length, 1);
  const byId = new Map((project?.issues ?? []).map((issue) => [issue.id, issue]));
  assert.deepEqual(byId.get("mw-6")?.blockedBy, ["mw-9"]);
  assert.equal(byId.get("mw-6")?.classification, "blocked");
  assert.equal(byId.get("mw-5")?.classification, "ready");
});

test("a config that could not be read is carried by the snapshot itself", async () => {
  const place = withConfig('{ "roots": [1, 2] ');
  const snapshot = await collectSnapshot(options(place));
  assert.deepEqual(snapshot.projects, []);
  assert.equal(snapshot.errors.length, 2);
  assert.equal(snapshot.errors[0]?.source, place.configPath);
  assert.equal(snapshot.errors[1]?.source, join(place.home, "work"));
  assert.match(snapshot.errors[1]?.message ?? "", /could not be read/);
});

test("a snapshot with no projects at all says why rather than reading as an empty machine", async () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-nothing-"));
  const scanned = join(home, "work");
  mkdirSync(join(scanned, "here"), { recursive: true });
  const snapshot = await collectSnapshot({
    env: { PATH: PATH_WITH_BD, XDG_STATE_HOME: join(home, "state") },
    home,
    cwd: join(scanned, "here"),
  });
  assert.deepEqual(snapshot.projects, []);
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.errors[0]?.source, scanned);
  assert.match(snapshot.errors[0]?.message ?? "", /falling back/);
  assert.ok((snapshot.errors[0]?.message ?? "").includes(join(home, ".config", "pitwall", "config.json")));
});

test("a healthy run with projects carries no run-level errors", async () => {
  const snapshot = await collectSnapshot(options(workspace([TRACKER])));
  assert.equal(snapshot.projects.length, 1);
  assert.deepEqual(snapshot.errors, []);
});

test("the snapshot is written where serve reads it", async () => {
  const place = workspace([TRACKER]);
  const result = await emitSnapshot(options(place));
  assert.equal(result.path, snapshotPath({ env: place.env, home: place.home }));
  const stored = readSnapshot({ env: place.env, home: place.home });
  assert.equal(stored.error, undefined);
  assert.deepEqual(stored.snapshot, JSON.parse(JSON.stringify(result.snapshot)));
});

test("a complete snapshot exits zero and one where every project failed does not", async () => {
  assert.equal((await emitSnapshot(options(workspace([TRACKER])))).code, 0);
  assert.equal((await emitSnapshot(options(workspace([TRACKER, NO_TRACKER])))).code, 0);
  assert.equal((await emitSnapshot(options(workspace([NO_TRACKER])))).code, 1);
  assert.equal((await emitSnapshot(options(workspace([])))).code, 0);
});

function announcing(place: Workspace, sessionRef?: string) {
  const sent: Notice[] = [];
  return {
    sent,
    run: () =>
      emitSnapshot({
        ...options(place),
        env: { ...place.env, BD_LIST_FIXTURE: "landed" },
        sessionRef,
        sender: (notice: Notice) => {
          sent.push(notice);
          return Promise.resolve({ delivered: true as const });
        },
        note: () => Promise.reject(new Error("no note should be needed")),
      }),
  };
}

test("an issue that closed since the previous collection reaches the session that asked", async () => {
  const place = workspace([TRACKER]);
  await emitSnapshot(options(place));
  const announced = announcing(place);
  const result = await announced.run();
  assert.deepEqual(
    announced.sent.map((notice) => [notice.issueId, notice.origin.ref, notice.origin.session]),
    [
      ["mw-1", "c1796a", "mw-planning-session"],
      ["mw-1.1", "c1796a", "mw-planning-session"],
    ],
  );
  assert.deepEqual(
    result.delivered.map((entry) => entry.delivery.delivered),
    [true, true],
  );
});

test("nothing is announced to the session that closed the work itself", async () => {
  const place = workspace([TRACKER]);
  await emitSnapshot(options(place));
  const announced = announcing(place, "c1796a");
  const result = await announced.run();
  assert.deepEqual(announced.sent, []);
  assert.deepEqual(result.delivered, []);
});

test("a collection with no sender delivers nothing at all", async () => {
  const place = workspace([TRACKER]);
  await emitSnapshot(options(place));
  const result = await emitSnapshot({
    ...options(place),
    env: { ...place.env, BD_LIST_FIXTURE: "landed" },
  });
  assert.deepEqual(result.delivered, []);
});

function pipelineRoot(remote: string): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-pipeline-snapshot-"));
  cpSync(join(TRACKER, "bd-output"), join(root, "bd-output"), { recursive: true });
  writeFileSync(
    join(root, ".pitwall.json"),
    JSON.stringify({ idPrefix: "mw", repos: { site: { path: "site" } } }),
  );
  const dir = join(root, "site");
  mkdirSync(dir, { recursive: true });
  for (const args of [["init", "--quiet"], ["remote", "add", "origin", remote]]) {
    const ran = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  }
  return root;
}

test("the open pull requests of a project reach the snapshot alongside its issues", async () => {
  const place = workspace([pipelineRoot("git@github.com:acme/site.git")]);
  const snapshot = await collectSnapshot({
    ...options(place),
    env: { ...place.env, PATH: PATH_WITH_GH, GH_OUTPUT: RECORDED },
  });
  const project = snapshot.projects[0];
  assert.deepEqual(project?.errors, []);
  assert.deepEqual(
    project?.pipeline.map((pull) => [pull.number, pull.checks]),
    [
      [101, "green"],
      [102, "red"],
      [103, "pending"],
      [104, "none"],
      [105, "green"],
    ],
  );
  assert.deepEqual(
    project?.pipeline.map((pull) => [pull.number, pull.issueId]),
    [
      [101, "mw-12"],
      [102, "mw-7"],
      [103, undefined],
      [104, undefined],
      [105, undefined],
    ],
  );
  assert.equal(project?.issues.length, 15);
  assert.doesNotThrow(() => parseSnapshot(snapshot));
});

test("a pipeline that could not be read is an error beside the issues, which still load", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const snapshot = await collectSnapshot({
    ...options(place),
    env: { ...place.env, PATH: PATH_WITH_UNAUTH_GH },
  });
  const project = snapshot.projects[0];
  assert.deepEqual(project?.pipeline, []);
  assert.equal(project?.errors.length, 1);
  assert.match(project?.errors[0]?.source ?? "", /^gh pr list --repo acme\/site/);
  assert.equal(project?.issues.length, 15);
});

test("gh that cannot authenticate leaves the run exiting zero on a tracker that read fine", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const result = await emitSnapshot({
    ...options(place),
    env: { ...place.env, PATH: PATH_WITH_UNAUTH_GH },
  });
  const project = result.snapshot.projects[0];
  assert.equal(project?.errors.length, 1);
  assert.match(project?.errors[0]?.source ?? "", /^gh pr list --repo acme\/site/);
  assert.equal(project?.issues.length, 15);
  assert.equal(result.code, 0);
});

test("gh that is not installed at all leaves the run exiting zero", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const result = await emitSnapshot({
    ...options(place),
    env: { ...place.env, PATH: pathWithoutGh() },
  });
  const project = result.snapshot.projects[0];
  assert.equal(project?.errors.length, 1);
  assert.match(project?.errors[0]?.source ?? "", /^gh pr list --repo acme\/site/);
  assert.match(project?.errors[0]?.message ?? "", /ENOENT/);
  assert.equal(project?.issues.length, 15);
  assert.equal(result.code, 0);
});

test("the snapshot reports whether the reason an issue stopped is still true", async () => {
  const place = workspace([TRACKER]);
  const asked: string[][] = [];
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "stale" },
    probe: async (command) => {
      asked.push([...command]);
      return true;
    },
    pullFacts: async () => undefined,
  });
  const byId = new Map((snapshot.projects[0]?.issues ?? []).map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-20")?.staleness.verdict, "resolved");
  assert.ok(
    byId.get("mw-20")?.staleness.evidence.some((line) => line.includes("mw-9")),
    "the resolved verdict names the issue that closed",
  );
  assert.equal(byId.get("mw-21")?.staleness.verdict, "likely-stale");
  assert.equal(byId.get("mw-22")?.classification, "yours:decision");
  assert.equal(byId.get("mw-22")?.staleness.verdict, "likely-stale");
  assert.equal(byId.get("mw-23")?.staleness.verdict, "unchecked");
  assert.equal(byId.get("mw-23")?.staleness.checkedAt, undefined);
  assert.equal(byId.get("mw-24")?.classification, "parked:roadmap");
  assert.equal(byId.get("mw-24")?.staleness.verdict, "likely-stale");
  assert.ok(
    !byId
      .get("mw-24")
      ?.staleness.evidence.some((line) => line.includes("no open dependency of its own remains")),
    "a parking label does not hide the open child from the snapshot",
  );
  assert.ok(asked.length > 0);
  assert.ok(asked.every((command) => command.join(" ") === "npm whoami"));
});

test("emitting a snapshot appends it to the history store", { skip: !hasSqlite }, async () => {
  const place = workspace([TRACKER]);
  const state = { env: place.env, home: place.home };
  await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  const result = await emitSnapshot(options(place, new Date("2026-09-08T10:00:00Z")));
  const rows = readFileSync(historyPath(state));
  assert.ok(rows.length > 0);
  assert.equal(result.snapshot.projects[0]?.metrics.landedToday, 0);
  assert.doesNotThrow(() => parseSnapshot(result.snapshot));
});

test("the snapshot carries no run-level error on any supported Node", async () => {
  const place = workspace([TRACKER]);
  const result = await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  assert.deepEqual(result.snapshot.errors, []);
});

test("a history store that cannot be opened costs the metrics, not the snapshot", { skip: !hasSqlite }, async () => {
  const place = workspace([TRACKER]);
  const path = historyPath({ env: place.env, home: place.home });
  mkdirSync(path, { recursive: true });
  const result = await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  assert.equal(result.code, 0);
  assert.equal(result.snapshot.projects[0]?.issues.length, 15);
  assert.equal(result.snapshot.errors.length, 1);
  assert.equal(result.snapshot.errors[0]?.source, path);
  assert.equal(result.snapshot.projects[0]?.metrics.medianTimeToLandMinutes, undefined);
  assert.equal(readSnapshot({ env: place.env, home: place.home }).error, undefined);
});

test("an issue left in progress after its pull request merged is reported, not left running", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "stale" },
    probe: async () => true,
    pullFacts: async (reference) =>
      reference.text === "site#16" ? { state: "merged", issueId: "mw-26" } : undefined,
  });
  const byId = new Map((snapshot.projects[0]?.issues ?? []).map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-26")?.classification, "landing");
  assert.equal(byId.get("mw-26")?.staleness.verdict, "likely-stale");
  assert.ok(
    byId.get("mw-26")?.staleness.evidence.some((line) => line.includes("site#16")),
    "the verdict does not name the pull request that merged",
  );
});

test("a staleness probe that could not be run reaches the project as one error", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, PATH: pathWithoutGh(), BD_LIST_FIXTURE: "stale" },
  });
  const project = snapshot.projects[0];
  const recorded = (project?.errors ?? []).filter((error) => error.source === "npm whoami");
  assert.equal(recorded.length, 1);
  assert.match(recorded[0]?.message ?? "", /ENOENT/);
  const byId = new Map((project?.issues ?? []).map((issue) => [issue.id, issue]));
  assert.deepEqual(
    (project?.errors ?? [])
      .filter((error) => error.source === "staleness mw-21")
      .map((error) => error.message),
    ["1 precondition could not be run: `npm whoami`"],
    "the probe that could not be run is recorded against the issue it was run for",
  );
  assert.ok(
    !byId.get("mw-21")?.staleness.evidence.some((line) => line.includes("could not be run")),
    "a probe that could not run is a collection failure, not a finding about the issue",
  );
});

test("references the run could not resolve leave the evidence and reach the project errors", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "stale" },
    probe: async () => true,
    pullFacts: async () => undefined,
  });
  const project = snapshot.projects[0];
  const unresolved = (project?.errors ?? []).filter((error) => error.source.startsWith("staleness "));
  assert.ok(unresolved.length > 0, "a reference nobody could look up is recorded somewhere");
  for (const error of unresolved) {
    assert.match(error.message, /^\d+ references? could not be checked: /);
  }
  for (const issue of project?.issues ?? []) {
    assert.ok(
      !issue.staleness.evidence.some((line) => line.includes("could not resolve")),
      `${issue.id} still renders a failed lookup as a finding`,
    );
  }
  assert.equal(
    (project?.errors ?? []).filter((error) => error.source === "staleness").length,
    0,
    "a configured run records no run-level staleness failure",
  );
});

test("a staleness failure of the run itself is recorded once, not once per issue", async () => {
  const place = workspace([degradedRoot()]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "stale" },
  });
  const project = snapshot.projects[0];
  assert.ok((project?.issues ?? []).length > 1, "more than one issue was assessed");
  const run = (project?.errors ?? []).filter((error) => error.source === "staleness");
  assert.deepEqual(run.map((error) => error.message), [
    "the project records no issue id prefix, so referenced issues cannot be recognised",
    "no pull request host is configured, so pull requests could not be looked up",
  ]);
});

test("a project whose references could not be looked up is not an unreadable project", async () => {
  const place = workspace([TRACKER]);
  const result = await emitSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "stale" },
    probe: async () => true,
    pullFacts: async () => undefined,
  });
  assert.ok(
    (result.snapshot.projects[0]?.errors ?? []).some((error) => error.source.startsWith("staleness ")),
    "the run recorded at least one reference it could not check",
  );
  assert.equal(result.code, 0);
});

test("a collection that reads nothing leaves the board that is stored where it is", async () => {
  const place = workspace([TRACKER]);
  const state = { env: place.env, home: place.home };
  const good = await emitSnapshot(options(place));
  assert.equal(good.read, true);
  const path = snapshotPath(state);
  assert.equal(good.path, path);
  const before = readFileSync(path, "utf8");

  writeFileSync(place.configPath, JSON.stringify({ roots: [NO_TRACKER] }));
  const failed = await emitSnapshot(options(place));
  assert.equal(failed.read, false);
  assert.equal(failed.path, undefined);
  assert.equal(failed.code, 1);
  assert.equal(readFileSync(path, "utf8"), before);

  writeFileSync(place.configPath, JSON.stringify({ roots: [] }));
  const none = await emitSnapshot(options(place));
  assert.equal(none.read, false);
  assert.equal(none.path, undefined);
  assert.equal(none.code, 0);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("the console's own collector keeps the last board when it can read nothing", async (t) => {
  const place = workspace([TRACKER]);
  const state = { env: place.env, home: place.home };
  const good = await emitSnapshot(options(place, new Date("2026-09-08T10:00:00Z")));
  assert.equal(good.read, true);
  writeFileSync(place.configPath, JSON.stringify({ roots: [NO_TRACKER] }));

  const running: Array<Promise<unknown>> = [];
  const collect = consoleCollector(options(place));
  const server = createConsoleServer({
    ...state,
    collect: () => {
      const attempt = collect();
      running.push(attempt);
      return attempt;
    },
  });
  t.after(() => server.close());
  await listen(server, 0);
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  await fetch(`${origin}/api/snapshot`);
  assert.equal(running.length, 1);
  await running[0];
  await new Promise((done) => setImmediate(done));

  const body = (await (await fetch(`${origin}/api/snapshot`)).json()) as {
    generatedAt: string;
    projects: unknown[];
    errors: Array<{ source: string; message: string }>;
  };
  assert.equal(body.generatedAt, good.snapshot.generatedAt);
  assert.deepEqual(body.projects, JSON.parse(JSON.stringify(good.snapshot.projects)));
  const refresh = body.errors.find((error) => error.source === REFRESH_SOURCE);
  assert.ok(refresh, "the served board carries the failed refresh");
  assert.match(refresh.message, /^No project could be read\./);
  assert.equal(
    readFileSync(snapshotPath(state), "utf8"),
    JSON.stringify(good.snapshot, null, 2) + "\n",
  );
});

function readableRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-kept-"));
  cpSync(TRACKER, root, { recursive: true });
  return root;
}

test("a project that could not be read keeps the issues the last snapshot held for it", async () => {
  const root = readableRoot();
  const id = basename(root);
  const place = workspace([root, TRACKER]);
  const state = { env: place.env, home: place.home };
  const first = await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  assert.equal(first.snapshot.projects.find((project) => project.id === id)?.issues.length, 15);

  rmSync(join(root, "bd-output"), { recursive: true });
  const second = await emitSnapshot(options(place, new Date("2026-09-08T09:30:00Z")));
  assert.equal(second.read, true);
  const stored = readSnapshot(state).snapshot;
  assert.ok(stored);
  const kept = stored.projects.find((project) => project.id === id);
  assert.equal(kept?.issues.length, 15, "an unreadable project must not be emptied on disk");
  assert.equal(kept?.metrics.readyCount, 2, "its figures must agree with the issues it carries");
  assert.equal(kept?.metrics.landedToday, undefined);
  assert.ok(
    (kept?.errors ?? []).some((error) => error.source === join(root, ".beads")),
    "the project still reports what it could not read",
  );
  assert.equal(
    (kept?.errors ?? []).find((error) => error.source === KEPT_SOURCE)?.at,
    "2026-09-08T09:00:00.000Z",
    "the kept issues are dated when they were last read, not when the run happened",
  );
  const fresh = stored.projects.find((project) => project.id === "tracker");
  assert.deepEqual(fresh?.errors, []);

  const board = buildBoard(stored);
  assert.equal(board.refreshFailure?.source, PARTIAL_SOURCE, "the board must not read as current");
  assert.equal(
    board.refreshFailure?.message,
    `1 of 2 projects could not be read: ${id} (issues kept from the last snapshot).`,
  );
  assert.deepEqual(
    board.running.filter((row) => row.projectId === id),
    [],
    "carried issues must not be counted as running now",
  );
  assert.ok(
    board.running.some((row) => row.projectId === "tracker"),
    "the project that was read keeps its running rows",
  );
  assert.ok(
    board.ready.some((row) => row.projectId === id),
    "the carried backlog is still on the board",
  );

  const third = await emitSnapshot(options(place, new Date("2026-09-08T10:00:00Z")));
  const again = third.snapshot.projects.find((project) => project.id === id);
  assert.equal(again?.issues.length, 15);
  assert.equal(
    (again?.errors ?? []).find((error) => error.source === KEPT_SOURCE)?.at,
    "2026-09-08T09:00:00.000Z",
    "a second failed run must not re-date issues it did not read either",
  );
});

function lanedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-laned-"));
  writeFileSync(
    join(root, ".autofix.json"),
    JSON.stringify({ idPrefix: "mw", lockPrefix: basename(root), lanes: 2 }),
  );
  cpSync(join(TRACKER, "bd-output"), join(root, "bd-output"), { recursive: true });
  return root;
}

test("a project whose issues were read keeps them even though the rest of it failed", async () => {
  const root = lanedRoot();
  const id = basename(root);
  const place = workspace([root, TRACKER]);
  const state = { env: place.env, home: place.home };
  const first = await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  const before = first.snapshot.projects.find((project) => project.id === id);
  assert.deepEqual(before?.errors, [], "the first run reads the project in full");
  assert.equal(before?.issues.length, 15);

  const file = join(place.home, "lock-root-is-a-file");
  writeFileSync(file, "");
  const second = await emitSnapshot({
    ...options(place, new Date("2026-09-08T09:30:00Z")),
    lockRoot: file,
    env: { ...place.env, BD_LIST_FIXTURE: "partial" },
  });
  assert.equal(second.read, true);
  const stored = readSnapshot(state).snapshot;
  assert.ok(stored);
  const project = stored.projects.find((entry) => entry.id === id);
  assert.deepEqual(
    (project?.issues ?? []).map((issue) => issue.id).sort(),
    ["mw-5", "mw-6"],
    "the issues the tracker answered with must survive the lane failure",
  );
  assert.equal(
    (project?.errors ?? []).some((error) => error.source === KEPT_SOURCE),
    false,
    "a project that answered is not a project whose issues were kept",
  );
  assert.deepEqual(
    (project?.errors ?? []).map((error) => error.source),
    [join(file, `${id}-slots`)],
    "the project reports the lane read it could not do",
  );
  assert.equal(
    buildBoard(stored).refreshFailure?.message,
    `1 of 2 projects could not be read: ${id} (issues read, the rest of the project was not).`,
  );
});

test("a tracker that answered with nothing is not a tracker that could not be read", async () => {
  const root = lanedRoot();
  const id = basename(root);
  const other = readableRoot();
  const place = workspace([root, other]);
  const state = { env: place.env, home: place.home };
  const first = await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  assert.equal(first.snapshot.projects.find((project) => project.id === id)?.issues.length, 15);

  writeFileSync(join(root, "bd-output", "closed.json"), "[]");
  cpSync(join(other, "bd-output", "all.json"), join(other, "bd-output", "closed.json"));
  const file = join(place.home, "lock-root-is-a-file");
  writeFileSync(file, "");
  await emitSnapshot({
    ...options(place, new Date("2026-09-08T09:30:00Z")),
    lockRoot: file,
    env: { ...place.env, BD_LIST_FIXTURE: "closed" },
  });
  const stored = readSnapshot(state).snapshot;
  assert.ok(stored);
  const project = stored.projects.find((entry) => entry.id === id);
  assert.deepEqual(project?.issues, [], "a project whose work has all closed stays empty");
  assert.equal(
    (project?.errors ?? []).some((error) => error.source === KEPT_SOURCE),
    false,
    "nothing is carried into a project whose tracker answered",
  );
  assert.equal(
    buildBoard(stored).refreshFailure?.message,
    `1 of 2 projects could not be read: ${id} (issues read, the rest of the project was not).`,
  );
});

test("the run-level problem describes what became of each project it names", async () => {
  const root = readableRoot();
  const id = basename(root);
  const place = workspace([root, TRACKER, NO_TRACKER]);
  const state = { env: place.env, home: place.home };
  const first = await emitSnapshot(options(place, new Date("2026-09-08T09:00:00Z")));
  assert.equal(
    buildBoard(first.snapshot).refreshFailure?.message,
    "1 of 3 projects could not be read: plain (issues missing from this board).",
    "a project nobody has ever read has no issues to be stale",
  );

  rmSync(join(root, "bd-output"), { recursive: true });
  await emitSnapshot(options(place, new Date("2026-09-08T09:30:00Z")));
  const stored = readSnapshot(state).snapshot;
  assert.ok(stored);
  assert.equal(
    buildBoard(stored).refreshFailure?.message,
    `2 of 3 projects could not be read: ${id} (issues kept from the last snapshot), plain (issues missing from this board).`,
  );
});
