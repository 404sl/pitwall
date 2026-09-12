import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import type { AddressInfo } from "node:net";
import { SCHEMA_VERSION, isYours, parseSnapshot, type Snapshot } from "@404sl/pitwall-schema";
import type { Notice } from "../src/notify.ts";
import { KEPT_SOURCE, PARTIAL_SOURCE, REFRESH_SOURCE, buildBoard } from "../src/board.ts";
import { consoleCollector, createConsoleServer, listen } from "../src/serve.ts";
import { collectSnapshot, emitSnapshot } from "../src/snapshot.ts";
import { historyPath } from "../src/history.ts";
import { SESSION_REF_VAR } from "../src/sender.ts";
import { readSnapshot, snapshotPath } from "../src/state.ts";
import { CLOSE_SOURCE, upstreamReport, type Closure } from "../src/upstream.ts";
import { VERSION } from "../src/version.ts";
import { nullGlobalGitConfig, spawnGit } from "./support/git.js";

nullGlobalGitConfig();

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
const PATH_WITH_SLOW_NPM = `${join(FIXTURES, "npm", "slow")}:${join(FIXTURES, "bd", "ok")}:/usr/bin:/bin`;

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

test("a run that was never told where to look and found nothing exits non-zero", async () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-nothing-"));
  const scanned = join(home, "work");
  mkdirSync(join(scanned, "here"), { recursive: true });
  const result = await emitSnapshot({
    env: { PATH: PATH_WITH_BD, XDG_STATE_HOME: join(home, "state") },
    home,
    cwd: join(scanned, "here"),
    lockRoot: mkdtempSync(join(tmpdir(), "pitwall-snapshot-lock-")),
  });
  assert.deepEqual(result.snapshot.projects, []);
  assert.equal(result.read, false);
  assert.equal(result.path, undefined);
  assert.equal(result.code, 1);
});

test("a config that could not be read and a scan that found nothing exits non-zero", async () => {
  const place = withConfig('{ "roots": [1, 2] ');
  const result = await emitSnapshot(options(place));
  assert.deepEqual(result.snapshot.projects, []);
  assert.equal(result.code, 1);
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

test("a run killed while it is announcing leaves the transition for the next run", async () => {
  const place = workspace([TRACKER]);
  const first = await emitSnapshot(options(place));
  const source = fileURLToPath(new URL("../src/snapshot.ts", import.meta.url));
  const probe = [
    `const { emitSnapshot } = await import(${JSON.stringify(source)});`,
    `await emitSnapshot({`,
    `  env: ${JSON.stringify({ ...place.env, BD_LIST_FIXTURE: "landed" })},`,
    `  home: ${JSON.stringify(place.home)},`,
    `  cwd: ${JSON.stringify(join(place.home, "work", "here"))},`,
    `  lockRoot: ${JSON.stringify(mkdtempSync(join(tmpdir(), "pitwall-killed-lock-")))},`,
    `  sender: () => { process.kill(process.pid, "SIGKILL"); return new Promise(() => {}); },`,
    `  note: () => Promise.reject(new Error("no note should be needed")),`,
    `});`,
  ].join("\n");
  const killed = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe],
    { encoding: "utf8" },
  );
  assert.equal(killed.signal, "SIGKILL", `the announcing run was not killed: ${killed.stderr}`);
  const onDisk = readSnapshot({ env: place.env, home: place.home }).snapshot;
  assert.equal(
    onDisk?.generatedAt,
    first.snapshot.generatedAt,
    "the killed run wrote its snapshot before its notices went out",
  );
  const announced = announcing(place);
  await announced.run();
  assert.deepEqual(
    announced.sent.map((notice) => notice.issueId),
    ["mw-1", "mw-1.1"],
  );
});

function notifyingRoot(place: Workspace): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "pitwall-notify-snapshot-"));
  cpSync(join(TRACKER, "bd-output"), join(root, "bd-output"), { recursive: true });
  const log = join(root, "delivered.jsonl");
  writeFileSync(
    join(root, "notify.mjs"),
    `import { appendFileSync, readFileSync } from "node:fs";
     appendFileSync(${JSON.stringify(log)}, readFileSync(0, "utf8"));`,
  );
  writeFileSync(
    join(root, ".pitwall.json"),
    JSON.stringify({ idPrefix: "mw", notify: [execPath, join(root, "notify.mjs")] }),
  );
  writeFileSync(place.configPath, JSON.stringify({ roots: [root] }));
  return { root, log };
}

test("a collection that supplies no sender reaches the command the workspace configures", async () => {
  const place = withConfig("{}");
  const { log } = notifyingRoot(place);
  const env = { ...place.env, [SESSION_REF_VAR]: "9f31bd" };
  await emitSnapshot({ ...options(place), env });
  const result = await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "landed" },
  });
  assert.deepEqual(
    result.delivered.map((entry) => [entry.notice.issueId, entry.delivery.delivered]),
    [
      ["mw-1", true],
      ["mw-1.1", true],
    ],
  );
  assert.deepEqual(
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as Notice).issueId),
    ["mw-1", "mw-1.1"],
  );
});

test(`${SESSION_REF_VAR} is what keeps a session from being told about its own work`, async () => {
  const place = withConfig("{}");
  const { log } = notifyingRoot(place);
  const env = { ...place.env, [SESSION_REF_VAR]: "c1796a" };
  await emitSnapshot({ ...options(place), env });
  const result = await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "landed" },
  });
  assert.deepEqual(result.delivered, []);
  assert.equal(existsSync(log), false);
});

test("with no ref for this session a notice is computed, held and recorded on the issue", async () => {
  const place = withConfig("{}");
  const { root, log } = notifyingRoot(place);
  const notes = join(root, "notes.log");
  await emitSnapshot({ ...options(place), env: place.env });
  const result = await emitSnapshot({
    ...options(place),
    env: { ...place.env, BD_LIST_FIXTURE: "landed", BD_NOTES_LOG: notes },
  });
  assert.deepEqual(
    result.delivered.map((entry) => [entry.notice.issueId, entry.delivery.delivered]),
    [
      ["mw-1", false],
      ["mw-1.1", false],
    ],
  );
  assert.deepEqual(
    result.delivered.map((entry) => entry.error),
    [undefined, undefined],
  );
  assert.equal(existsSync(log), false);
  const recorded = readFileSync(notes, "utf8");
  assert.match(recorded, /mw-1 Completion notice for mw-planning-session \(c1796a\)/);
  assert.match(recorded, new RegExp(`${SESSION_REF_VAR} is not set`));
  assert.match(recorded, /mw-1\.1 Completion notice/);
});

function scannedRoot(place: Workspace, name: string, notify: boolean): string {
  const root = join(place.home, "work", name);
  mkdirSync(root, { recursive: true });
  cpSync(join(TRACKER, "bd-output"), join(root, "bd-output"), { recursive: true });
  writeFileSync(
    join(root, "notify.mjs"),
    `import { appendFileSync, readFileSync } from "node:fs";
     appendFileSync(${JSON.stringify(join(root, "delivered.jsonl"))}, readFileSync(0, "utf8"));`,
  );
  writeFileSync(
    join(root, ".pitwall.json"),
    JSON.stringify(
      notify ? { idPrefix: "mw", notify: [execPath, join(root, "notify.mjs")] } : { idPrefix: "mw" },
    ),
  );
  return root;
}

test("a workspace found by scanning neither runs its own command nor is written to", async () => {
  const place = withConfig("{}");
  rmSync(place.configPath);
  const root = scannedRoot(place, "scanned", true);
  const log = join(root, "delivered.jsonl");
  const notes = join(root, "notes.log");
  const env = { ...place.env, [SESSION_REF_VAR]: "9f31bd" };
  await emitSnapshot({ ...options(place), env });
  const result = await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "landed", BD_NOTES_LOG: notes },
  });
  assert.deepEqual(result.delivered, []);
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(notes), false);
  assert.equal(result.unlisted.length, 1);
  assert.equal(result.unlisted[0]?.source, place.configPath);
  const said = result.unlisted[0]?.message ?? "";
  assert.match(said, /1 workspace found by scanning names a notify command/);
  assert.match(said, new RegExp(root));
  assert.match(said, new RegExp(place.configPath));
});

test("a scanned workspace that names no command is nothing to report", async () => {
  const place = withConfig("{}");
  rmSync(place.configPath);
  scannedRoot(place, "scanned", false);
  const result = await emitSnapshot({ ...options(place), env: place.env });
  assert.deepEqual(result.unlisted, []);
});

test("the board reports a scanned notifier once, and the same row after a refresh", async () => {
  const place = withConfig("{}");
  rmSync(place.configPath);
  const root = scannedRoot(place, "scanned", true);
  const notes = join(root, "notes.log");
  const { errors } = await consoleCollector({ ...options(place), env: place.env })();
  const refreshed = await consoleCollector({
    ...options(place),
    env: { ...place.env, BD_LIST_FIXTURE: "landed", BD_NOTES_LOG: notes },
  })();
  const said = (rows: readonly { source: string; message: string }[]) =>
    rows.filter((row) => row.source === place.configPath).map((row) => row.message);
  assert.equal(said(errors).length, 1);
  assert.match(said(errors)[0] ?? "", /no completion notice is delivered for it/);
  assert.deepEqual(said(refreshed.errors), said(errors));
  assert.deepEqual(
    refreshed.errors.filter((error) => /notice for mw-planning-session/.test(error.message)),
    [],
  );
  assert.equal(existsSync(notes), false);
});

test("a notice the tracker would not record reaches the board as an error", async () => {
  const place = withConfig("{}");
  notifyingRoot(place);
  await emitSnapshot({ ...options(place), env: place.env });
  const collect = consoleCollector({
    ...options(place),
    env: { ...place.env, BD_LIST_FIXTURE: "landed" },
  });
  const { errors } = await collect();
  const lost = errors.filter((error) => /notice for mw-planning-session/.test(error.message));
  assert.deepEqual(
    lost.map((error) => error.source),
    ["mw-1", "mw-1.1"],
  );
  assert.match(lost[0]?.message ?? "", /was not delivered/);
  assert.match(lost[0]?.message ?? "", /could not be recorded on the issue either/);
});

function pipelineRoot(remote: string, where?: string): string {
  const root = where ?? mkdtempSync(join(tmpdir(), "pitwall-pipeline-snapshot-"));
  mkdirSync(root, { recursive: true });
  cpSync(join(TRACKER, "bd-output"), join(root, "bd-output"), { recursive: true });
  writeFileSync(
    join(root, ".pitwall.json"),
    JSON.stringify({ idPrefix: "mw", repos: { site: { path: "site" } } }),
  );
  const dir = join(root, "site");
  mkdirSync(dir, { recursive: true });
  for (const args of [["init", "--quiet"], ["remote", "add", "origin", remote]]) {
    const ran = spawnGit(args, { cwd: dir });
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

test("a bead that closed carrying an external-ref closes the issue it came from", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const env = { ...place.env, PATH: PATH_WITH_GH, GH_OUTPUT: RECORDED };
  await emitSnapshot({ ...options(place), env });
  const asked: Closure[] = [];
  const result = await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "shipped" },
    sender: () => Promise.resolve({ delivered: true as const }),
    note: () => Promise.reject(new Error("no note should be needed")),
    closer: (closure: Closure) => {
      asked.push(closure);
      return Promise.resolve({ closed: true as const });
    },
  });
  assert.deepEqual(
    asked.map((closure) => [closure.issueId, closure.issue.url]),
    [["mw-1", "https://github.com/acme/site/issues/7"]],
  );
  assert.equal(asked[0]?.comment, "Landed in site `#101`. Tracked as mw-1.");
  assert.deepEqual(result.upstream.left, []);
  assert.deepEqual(
    result.upstream.reported.map((entry) => entry.result.closed),
    [true],
  );
  assert.deepEqual(upstreamReport(result.upstream), []);
});

test("a run killed while it is closing upstream leaves the closure for the next run", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const env = { ...place.env, PATH: PATH_WITH_GH, GH_OUTPUT: RECORDED };
  const first = await emitSnapshot({ ...options(place), env });
  const source = fileURLToPath(new URL("../src/snapshot.ts", import.meta.url));
  const probe = [
    `const { emitSnapshot } = await import(${JSON.stringify(source)});`,
    `await emitSnapshot({`,
    `  env: ${JSON.stringify({ ...env, BD_LIST_FIXTURE: "shipped" })},`,
    `  home: ${JSON.stringify(place.home)},`,
    `  cwd: ${JSON.stringify(join(place.home, "work", "here"))},`,
    `  lockRoot: ${JSON.stringify(mkdtempSync(join(tmpdir(), "pitwall-killed-lock-")))},`,
    `  sender: () => Promise.resolve({ delivered: true }),`,
    `  note: () => Promise.reject(new Error("no note should be needed")),`,
    `  closer: () => { process.kill(process.pid, "SIGKILL"); return new Promise(() => {}); },`,
    `});`,
  ].join("\n");
  const killed = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe],
    { encoding: "utf8" },
  );
  assert.equal(killed.signal, "SIGKILL", `the closing run was not killed: ${killed.stderr}`);
  const onDisk = readSnapshot({ env: place.env, home: place.home }).snapshot;
  assert.equal(
    onDisk?.generatedAt,
    first.snapshot.generatedAt,
    "the killed run wrote its snapshot before its upstream closures went out",
  );
  const asked: Closure[] = [];
  await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "shipped" },
    sender: () => Promise.resolve({ delivered: true as const }),
    note: () => Promise.reject(new Error("no note should be needed")),
    closer: (closure: Closure) => {
      asked.push(closure);
      return Promise.resolve({ closed: true as const });
    },
  });
  assert.deepEqual(
    asked.map((closure) => [closure.issueId, closure.issue.url]),
    [["mw-1", "https://github.com/acme/site/issues/7"]],
  );
});

test("a workspace found by scanning closes nothing on GitHub", async () => {
  const place = withConfig("{}");
  rmSync(place.configPath);
  pipelineRoot("https://github.com/acme/site.git", join(place.home, "work", "scanned"));
  const env = { ...place.env, PATH: PATH_WITH_GH, GH_OUTPUT: RECORDED };
  await emitSnapshot({ ...options(place), env });
  const result = await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "shipped" },
  });
  assert.deepEqual(result.upstream, { reported: [], left: [] });
});

test("a checkout that will not say what its origin is turns nothing off quietly", async () => {
  const root = pipelineRoot("https://github.com/acme/site.git");
  const place = workspace([root]);
  const env = { ...place.env, PATH: PATH_WITH_GH, GH_OUTPUT: RECORDED };
  await emitSnapshot({ ...options(place), env });
  const repo = join(root, "site");
  rmSync(join(repo, ".git"), { recursive: true, force: true });
  writeFileSync(join(repo, ".git"), `gitdir: ${join(root, "nowhere")}\n`);
  const result = await emitSnapshot({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "shipped" },
    closer: () => Promise.reject(new Error("nothing may be closed when ownership is unknown")),
    note: () => Promise.reject(new Error("nothing may be noted when ownership is unknown")),
  });
  assert.deepEqual(result.upstream.reported, []);
  assert.equal(result.upstream.left.length, 1);
  assert.match(result.upstream.left[0]?.reason ?? "", /could not tell whether acme\/site/);
  assert.match(result.upstream.left[0]?.reason ?? "", /site would not say what its origin is/);
  assert.match(upstreamReport(result.upstream)[0] ?? "", /was left open because/);
});

test("an issue that could not be closed is recorded on the bead and collected as an error", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const env = { ...place.env, PATH: PATH_WITH_GH, GH_OUTPUT: RECORDED };
  await emitSnapshot({ ...options(place), env });
  const { errors } = await consoleCollector({
    ...options(place),
    env: { ...env, BD_LIST_FIXTURE: "shipped", BD_NOTES_LOG: join(place.home, "notes.log") },
    closer: () =>
      Promise.resolve({ closed: false as const, reason: "HTTP 403: Resource not accessible" }),
  })();
  const refused = errors.filter((error) => error.source === CLOSE_SOURCE);
  assert.equal(refused.length, 1);
  assert.match(refused[0]?.message ?? "", /acme\/site\/issues\/7 was not commented and not closed/);
  assert.match(refused[0]?.message ?? "", /HTTP 403: Resource not accessible/);
  assert.match(readFileSync(join(place.home, "notes.log"), "utf8"), /mw-1 .*HTTP 403/);
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

test("the snapshot reads the note time from the tracker, and says once which timestamp it could not establish", async () => {
  const place = workspace([TRACKER]);
  const snapshot = await collectSnapshot({
    ...options(place, new Date("2026-09-08T09:00:00Z")),
    env: { ...place.env, BD_LIST_FIXTURE: "noted" },
    probe: async () => true,
    pullFacts: async () => undefined,
  });
  const project = snapshot.projects[0];
  const errors = project?.errors ?? [];
  assert.deepEqual(
    errors
      .filter((error) => error.message.startsWith("nothing records when"))
      .map((error) => [error.source, error.message]),
    [
      ["staleness", "nothing records when an issue stopped, so a note written since cannot be recognised"],
      [
        "staleness",
        "nothing records when an issue stopped or when the newest note was written," +
          " so a note written since cannot be recognised",
      ],
    ],
    "the stamp read off the newest note decides which timestamp the run reports, and each is reported once",
  );
  assert.deepEqual(
    errors.filter((error) => error.source.startsWith("staleness ")),
    [],
    "a limitation of the tracker names no issue, so no issue carries a line nobody can clear",
  );
  const byId = new Map((project?.issues ?? []).map((issue) => [issue.id, issue]));
  assert.equal(byId.get("mw-30")?.staleness.verdict, "unchecked");
  assert.deepEqual(byId.get("mw-30")?.staleness.evidence, []);
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

test("the only project there is writes its board when its tracker answered and its lanes did not", async () => {
  const root = lanedRoot();
  const id = basename(root);
  const place = workspace([root]);
  const state = { env: place.env, home: place.home };
  const file = join(place.home, "lock-root-is-a-file");
  writeFileSync(file, "");
  const result = await emitSnapshot({
    ...options(place, new Date("2026-09-08T09:30:00Z")),
    lockRoot: file,
    env: { ...place.env, BD_LIST_FIXTURE: "partial" },
  });
  assert.equal(result.read, true, "a tracker that answered is a collection that read something");
  assert.equal(result.code, 0);
  assert.equal(result.path, snapshotPath(state), "the snapshot must reach disk");
  const stored = readSnapshot(state).snapshot;
  assert.ok(stored);
  const project = stored.projects[0];
  assert.deepEqual(
    (project?.issues ?? []).map((issue) => issue.id).sort(),
    ["mw-5", "mw-6"],
    "the issues the tracker answered with must survive the lane failure",
  );
  assert.deepEqual(
    (project?.errors ?? []).map((error) => error.source),
    [join(file, `${id}-slots`)],
    "the project still reports the lane read it could not do",
  );
  assert.equal(
    stored.errors.some((error) => error.source === PARTIAL_SOURCE),
    false,
    "one project whose tracker answered is not a partial collection",
  );
});

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
  const board = buildBoard(stored);
  assert.equal(
    board.refreshFailure,
    undefined,
    "a project whose tracker answered is current, and must not flag the board",
  );
  assert.equal(
    stored.errors.some((error) => error.source === PARTIAL_SOURCE),
    false,
    "a lane that could not be read is not a collection that could not be read",
  );
  assert.deepEqual(
    board.ready.filter((row) => row.projectId === id).map((row) => row.id),
    ["mw-5"],
    "the issues the tracker answered with are on the board as read now",
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
    buildBoard(stored).refreshFailure,
    undefined,
    "every tracker answered, so nothing on this board is stale",
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

test("a probe that is still failing on the next run is dated from the first, so six hours of it reaches the board", async () => {
  const place = workspace([TRACKER]);
  const env = { ...place.env, PATH: PATH_WITH_SLOW_NPM, BD_LIST_FIXTURE: "stale" };
  const state = { env: place.env, home: place.home };
  const first = await emitSnapshot({ ...options(place), env, timeoutMs: 300 });
  const probed = (error: { source: string }) => error.source === "npm whoami";
  assert.ok(
    first.snapshot.projects[0]?.errors.some(probed),
    "the precondition probe must have been the thing that timed out",
  );
  const started = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
  writeFileSync(
    snapshotPath(state),
    JSON.stringify({
      ...first.snapshot,
      projects: first.snapshot.projects.map((project) => ({
        ...project,
        errors: project.errors.map((error) => (probed(error) ? { ...error, at: started } : error)),
      })),
    }),
  );
  await emitSnapshot({ ...options(place), env, timeoutMs: 300 });
  const written = readSnapshot(state).snapshot;
  assert.equal(
    written?.projects[0]?.errors.find(probed)?.at,
    started,
    "the written snapshot keeps the instant the probe first failed",
  );
  const shown = buildBoard(written as Snapshot).problems.filter(probed);
  assert.equal(shown.length, 1, "a probe that has not healed in seven hours is somebody's");
  assert.ok((shown[0]?.prevented ?? 0) > 0, "the checks it prevented are counted against it");
});
