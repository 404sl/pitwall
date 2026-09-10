import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Project } from "@404sl/pitwall-schema";
import { collectProjects, configPath, describeRoots, historyLimits, resolveRoots } from "../src/config.ts";
import { DEFAULT_LIMITS } from "../src/history.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SCAN = join(FIXTURES, "scan");
const NAMES = join(FIXTURES, "names");

function withConfig(contents: string): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "pitwall-config-"));
  const path = join(home, ".config", "pitwall", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return { home, path };
}

function config(roots: string[]): { home: string; path: string } {
  return withConfig(JSON.stringify({ roots }));
}

test("the default config location sits under the home directory", () => {
  const path = configPath({ env: {}, home: "/home/nobody" });
  assert.equal(path, join("/home/nobody", ".config", "pitwall", "config.json"));
});

test("PITWALL_CONFIG overrides the default location", () => {
  const path = configPath({ env: { PITWALL_CONFIG: "/elsewhere/pitwall.json" }, home: "/home/nobody" });
  assert.equal(path, "/elsewhere/pitwall.json");
});

test("roots come from the config file when it is there", () => {
  const { home } = config([join(FIXTURES, "multi"), join(FIXTURES, "single")]);
  const resolved = resolveRoots({ env: {}, home, cwd: SCAN });
  assert.equal(resolved.source, "config");
  assert.deepEqual(resolved.roots, [join(FIXTURES, "multi"), join(FIXTURES, "single")]);
  assert.deepEqual(resolved.errors, []);
});

test("a root listed twice is read once, in the order it was first listed", () => {
  const { home } = config([
    join(FIXTURES, "multi"),
    join(FIXTURES, "single"),
    `${join(FIXTURES, "multi")}/`,
  ]);
  const resolved = resolveRoots({ env: {}, home, cwd: SCAN });
  assert.deepEqual(resolved.roots, [join(FIXTURES, "multi"), join(FIXTURES, "single")]);
  assert.deepEqual(resolved.listed, [
    join(FIXTURES, "multi"),
    join(FIXTURES, "single"),
    join(FIXTURES, "multi"),
  ]);
  assert.equal(describeRoots(resolved), `2 workspace roots from ${resolved.configPath}`);
  const { projects } = collectProjects({ env: {}, home, cwd: SCAN });
  assert.equal(projects.length, 2);
});

test("roots come from a config named by PITWALL_CONFIG", () => {
  const { path } = config([join(FIXTURES, "plain")]);
  const resolved = resolveRoots({ env: { PITWALL_CONFIG: path }, home: "/home/nobody", cwd: SCAN });
  assert.equal(resolved.source, "config");
  assert.equal(resolved.from, path);
  assert.deepEqual(resolved.roots, [join(FIXTURES, "plain")]);
});

test("no config falls back to scanning the parent of the working directory", () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-nohome-"));
  const resolved = resolveRoots({ env: {}, home, cwd: join(SCAN, "alpha") });
  assert.equal(resolved.source, "scan");
  assert.equal(resolved.from, SCAN);
  assert.deepEqual(resolved.roots, [join(SCAN, "alpha"), join(SCAN, "beta")]);
  assert.deepEqual(resolved.errors, []);
});

test("a fallback scan that finds nothing says so rather than reporting an empty workspace", () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-nohome-"));
  const parent = mkdtempSync(join(tmpdir(), "pitwall-nothing-"));
  const cwd = join(parent, "here");
  mkdirSync(cwd);
  const resolved = resolveRoots({ env: {}, home, cwd });
  assert.equal(resolved.source, "scan");
  assert.deepEqual(resolved.roots, []);
  assert.equal(resolved.errors.length, 1);
  assert.equal(resolved.errors[0]?.source, parent);
  const said = resolved.errors[0]?.message ?? "";
  assert.match(said, /falling back/);
  assert.ok(said.includes(parent));
  assert.ok(said.includes(resolved.configPath));
});

test("a configured roots list that is empty is not described as a fallback scan", () => {
  const { home, path } = config([]);
  const resolved = resolveRoots({ env: {}, home, cwd: SCAN });
  assert.equal(resolved.source, "config");
  assert.deepEqual(resolved.roots, []);
  assert.equal(resolved.errors.length, 1);
  assert.equal(resolved.errors[0]?.source, path);
  const said = resolved.errors[0]?.message ?? "";
  assert.doesNotMatch(said, /falling back/);
  assert.ok(said.includes(path));
});

test("the fallback says that it scanned, and where", () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-nohome-"));
  const resolved = resolveRoots({ env: {}, home, cwd: join(SCAN, "alpha") });
  const said = describeRoots(resolved);
  assert.match(said, /scanning/);
  assert.ok(said.includes(SCAN));
  assert.match(said, /no config/);
  assert.ok(said.includes(resolved.configPath));

  const { home: withOne } = config([join(FIXTURES, "plain")]);
  const fromConfig = describeRoots(resolveRoots({ env: {}, home: withOne, cwd: SCAN }));
  assert.equal(fromConfig, `1 workspace root from ${join(withOne, ".config", "pitwall", "config.json")}`);
});

test("a malformed config is an error and the scan still produces roots", () => {
  const { home, path } = withConfig('{ "roots": [1, 2] ');
  const resolved = resolveRoots({ env: {}, home, cwd: join(SCAN, "alpha") });
  assert.equal(resolved.source, "scan");
  assert.equal(resolved.errors.length, 1);
  assert.equal(resolved.errors[0]?.source, path);
  assert.deepEqual(resolved.roots, [join(SCAN, "alpha"), join(SCAN, "beta")]);
});

test("a config without a roots array is an error rather than a crash", () => {
  const { home } = withConfig(JSON.stringify({ workspaces: ["/nope"] }));
  const resolved = resolveRoots({ env: {}, home, cwd: join(SCAN, "alpha") });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]?.message ?? "", /roots/);
});

test("one unreadable root does not stop the others loading", () => {
  const { home } = config([
    join(FIXTURES, "no-such-workspace"),
    join(FIXTURES, "broken"),
    join(FIXTURES, "unreadable"),
    join(FIXTURES, "multi"),
  ]);
  const { projects, roots } = collectProjects({ env: {}, home, cwd: SCAN });
  assert.equal(roots.source, "config");
  assert.equal(projects.length, 4);
  for (const project of projects) {
    assert.doesNotThrow(() => Project.parse(project));
  }
  assert.deepEqual(
    projects.map((project) => project.errors.length),
    [1, 1, 1, 0],
  );
  assert.equal(projects[3]?.repos.length, 3);
  assert.equal(projects[3]?.authority.idPrefix, "mw");
});

test("a config that could not be read is named as the reason for the scan", () => {
  const { home, path } = withConfig(JSON.stringify({ roots: [1, 2] }));
  const resolved = resolveRoots({ env: {}, home, cwd: join(SCAN, "alpha") });
  const said = describeRoots(resolved);
  assert.equal(resolved.source, "scan");
  assert.doesNotMatch(said, /no config/);
  assert.ok(said.includes(path));
  assert.ok(said.includes(resolved.errors[0]?.message ?? "unset"));
});

test("a PITWALL_CONFIG pointing at a directory is named the same way", () => {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-notafile-"));
  const resolved = resolveRoots({
    env: { PITWALL_CONFIG: dir },
    home: "/home/nobody",
    cwd: join(SCAN, "alpha"),
  });
  const said = describeRoots(resolved);
  assert.equal(resolved.source, "scan");
  assert.equal(resolved.errors[0]?.source, dir);
  assert.doesNotMatch(said, /no config/);
  assert.ok(said.includes(resolved.errors[0]?.message ?? "unset"));
});

test("the scan finds a workspace under either name", () => {
  const home = mkdtempSync(join(tmpdir(), "pitwall-nohome-"));
  const resolved = resolveRoots({ env: {}, home, cwd: join(NAMES, "newonly") });
  assert.equal(resolved.source, "scan");
  assert.deepEqual(resolved.roots, [
    join(NAMES, "both"),
    join(NAMES, "newonly"),
    join(NAMES, "oldonly"),
  ]);
  assert.deepEqual(resolved.errors, []);
});

test("the history bounds default until the config moves them", () => {
  const { home } = withConfig(
    JSON.stringify({
      roots: [],
      history: { maxSnapshots: 12, maxAgeDays: 3, minIntervalMinutes: 5 },
    }),
  );
  assert.deepEqual(historyLimits({ env: {}, home }), {
    maxSnapshots: 12,
    maxAgeDays: 3,
    minIntervalMinutes: 5,
  });
  const bare = withConfig(JSON.stringify({ roots: [] }));
  assert.deepEqual(historyLimits({ env: {}, home: bare.home }), DEFAULT_LIMITS);
  assert.deepEqual(historyLimits({ env: {}, home: "/home/nobody" }), DEFAULT_LIMITS);
});

test("a bound that a store cannot hold is not passed on as it was written", () => {
  const fractional = withConfig(JSON.stringify({ roots: [], history: { maxSnapshots: 2.5 } }));
  assert.equal(historyLimits({ env: {}, home: fractional.home }).maxSnapshots, 2);
  const nonsense = withConfig(JSON.stringify({ roots: [], history: { maxSnapshots: "lots", maxAgeDays: -4 } }));
  assert.deepEqual(historyLimits({ env: {}, home: nonsense.home }), DEFAULT_LIMITS);
  const tiny = withConfig(JSON.stringify({ roots: [], history: { maxSnapshots: 0.5 } }));
  assert.equal(historyLimits({ env: {}, home: tiny.home }).maxSnapshots, 1);
  const unthrottled = withConfig(JSON.stringify({ roots: [], history: { minIntervalMinutes: 0 } }));
  assert.equal(
    historyLimits({ env: {}, home: unthrottled.home }).minIntervalMinutes,
    DEFAULT_LIMITS.minIntervalMinutes,
  );
});
