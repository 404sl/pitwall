import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SCHEMA_VERSION, isYours, parseSnapshot } from "@404sl/pitwall-schema";
import { collectSnapshot, emitSnapshot } from "../src/snapshot.ts";
import { readSnapshot, snapshotPath } from "../src/state.ts";
import { VERSION } from "../src/version.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TRACKER = join(FIXTURES, "bd", "tracker");
const NO_TRACKER = join(FIXTURES, "plain");
const PATH_WITH_BD = `${join(FIXTURES, "bd", "ok")}:/usr/bin:/bin`;
const PATH_WITH_GH = `${join(FIXTURES, "bd", "ok")}:${join(FIXTURES, "gh", "ok")}:/usr/bin:/bin`;
const RECORDED = join(FIXTURES, "gh", "recorded");

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

test("a project that failed to collect blocks an issue whose blocker it never saw", async () => {
  const place = workspace([degradedRoot()]);
  const snapshot = await collectSnapshot({
    ...options(place),
    env: { ...place.env, BD_LIST_FIXTURE: "partial" },
  });
  const project = snapshot.projects[0];
  assert.equal(project?.errors.length, 1);
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
    ],
  );
  assert.equal(project?.issues.length, 15);
  assert.doesNotThrow(() => parseSnapshot(snapshot));
});

test("a pipeline that could not be read is an error beside the issues, which still load", async () => {
  const place = workspace([pipelineRoot("https://github.com/acme/site.git")]);
  const snapshot = await collectSnapshot({
    ...options(place),
    env: { ...place.env, PATH: `${join(FIXTURES, "bd", "ok")}:${join(FIXTURES, "gh", "unauth")}:/usr/bin:/bin` },
  });
  const project = snapshot.projects[0];
  assert.deepEqual(project?.pipeline, []);
  assert.equal(project?.errors.length, 1);
  assert.match(project?.errors[0]?.source ?? "", /^gh pr list --repo acme\/site/);
  assert.equal(project?.issues.length, 15);
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
    pullState: async () => undefined,
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
