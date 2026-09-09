import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_FILE } from "../src/autofix.ts";
import { diagnose, renderDoctor, type Check, type Diagnosis } from "../src/doctor.ts";
import { slotsPath } from "../src/lanes.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const BD_OUTPUT = join(FIXTURES, "bd", "tracker", "bd-output");
const BD_OK = join(FIXTURES, "bd", "ok");
const GH_OK = join(FIXTURES, "gh", "ok");
const GH_UNAUTH = join(FIXTURES, "gh", "unauth");

const SYSTEM = ["/usr/bin", "/bin"];

function env(bins: readonly string[]): Record<string, string | undefined> {
  return { PATH: bins.join(":") };
}

function withoutGh(): string {
  const bin = mkdtempSync(join(tmpdir(), "pitwall-doctor-nogh-"));
  for (const tool of ["dirname", "cat"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    assert.equal(found.status, 0, `${tool} is not on PATH`);
    symlinkSync(found.stdout.trim(), join(bin, tool));
  }
  return bin;
}

function home(roots: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-doctor-home-"));
  const path = join(dir, ".config", "pitwall", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ roots }));
  return dir;
}

function tracker(dir: string): void {
  mkdirSync(join(dir, ".beads"), { recursive: true });
  cpSync(BD_OUTPUT, join(dir, "bd-output"), { recursive: true });
}

function checkout(dir: string, name: string, git = true): void {
  mkdirSync(join(dir, name), { recursive: true });
  if (git) {
    mkdirSync(join(dir, name, ".git"), { recursive: true });
  }
}

function describe(dir: string, workspace: Record<string, unknown>): void {
  writeFileSync(join(dir, WORKSPACE_FILE), JSON.stringify(workspace));
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "pitwall-doctor-root-"));
}

function healthy(lockPrefix = "doctor"): string {
  const dir = root();
  tracker(dir);
  checkout(dir, "cli");
  describe(dir, { root: dir, idPrefix: "doc", lockPrefix, repos: { _: "ignored", site: { path: "cli" } } });
  return dir;
}

function options(roots: string[], bins: string[] = [BD_OK, GH_OK, ...SYSTEM]) {
  const place = home(roots);
  return {
    env: env(bins),
    home: place,
    cwd: place,
    lockRoot: mkdtempSync(join(tmpdir(), "pitwall-doctor-lock-")),
  };
}

function named(diagnosis: Diagnosis, name: string): Check {
  const found = diagnosis.checks.find((check) => check.name === name);
  assert.ok(found !== undefined, `no check named ${name}: ${diagnosis.checks.map((c) => c.name).join(", ")}`);
  return found;
}

test("a workspace with every source in place passes and exits zero", async () => {
  const dir = healthy();
  const diagnosis = await diagnose(options([dir]));
  assert.deepEqual(
    diagnosis.checks.filter((check) => check.severity !== "ok"),
    [],
  );
  assert.equal(diagnosis.code, 0);
});

test("bd missing from PATH fails the run and says so in the line it failed on", async () => {
  const dir = healthy();
  const diagnosis = await diagnose(options([dir], [GH_OK, ...SYSTEM]));
  const check = named(diagnosis, `${basename(dir)} bd`);
  assert.equal(check.severity, "fail");
  assert.match(check.result, /bd is not on PATH/);
  assert.match(check.tried, /bd statuses --json/);
  assert.equal(diagnosis.code, 1);
});

test("gh unauthenticated is a warning, because the screen degrades rather than empties", async () => {
  const dir = healthy();
  const diagnosis = await diagnose(options([dir], [BD_OK, GH_UNAUTH, ...SYSTEM]));
  const check = named(diagnosis, "gh");
  assert.equal(check.severity, "warn");
  assert.match(check.result, /gh auth login|not authenticated|GH_TOKEN/);
  assert.equal(diagnosis.code, 0);
});

test("gh missing from PATH is a warning that names the tool", async () => {
  const dir = healthy();
  const diagnosis = await diagnose(options([dir], [BD_OK, withoutGh()]));
  const check = named(diagnosis, "gh");
  assert.equal(check.severity, "warn");
  assert.match(check.result, /gh is not on PATH/);
});

test("two workspaces sharing a lockPrefix fail, naming both and the registry they share", async () => {
  const one = healthy("shared");
  const two = healthy("shared");
  const place = options([one, two]);
  const diagnosis = await diagnose(place);
  const check = named(diagnosis, "lockPrefix");
  assert.equal(check.severity, "fail");
  assert.match(check.result, new RegExp(one));
  assert.match(check.result, new RegExp(two));
  assert.match(check.result, new RegExp(slotsPath("shared", place.lockRoot)));
  assert.equal(diagnosis.code, 1);
});

test("two workspaces with prefixes of their own do not fail", async () => {
  const diagnosis = await diagnose(options([healthy("one"), healthy("two")]));
  assert.equal(named(diagnosis, "lockPrefix").severity, "ok");
  assert.equal(diagnosis.code, 0);
});

test("a repo path that is not a git checkout fails", async () => {
  const dir = root();
  tracker(dir);
  checkout(dir, "cli", false);
  describe(dir, { root: dir, idPrefix: "doc", lockPrefix: "doctor", repos: { site: { path: "cli" } } });
  const diagnosis = await diagnose(options([dir]));
  const check = named(diagnosis, `${basename(dir)} repo site`);
  assert.equal(check.severity, "fail");
  assert.match(check.result, /is not a git checkout/);
  assert.equal(diagnosis.code, 1);
});

test("a repo path that is not there at all fails with the path it tried", async () => {
  const dir = root();
  tracker(dir);
  describe(dir, { root: dir, idPrefix: "doc", lockPrefix: "doctor", repos: { site: { path: "cli" } } });
  const diagnosis = await diagnose(options([dir]));
  const check = named(diagnosis, `${basename(dir)} repo site`);
  assert.equal(check.severity, "fail");
  assert.match(check.result, new RegExp(`no directory at ${join(dir, "cli")}`));
});

test("a workspace whose root names another directory fails", async () => {
  const dir = healthy();
  describe(dir, { root: "/nowhere/that/exists", idPrefix: "doc", lockPrefix: "doctor", repos: {} });
  const diagnosis = await diagnose(options([dir]));
  const check = named(diagnosis, `${basename(dir)} root`);
  assert.equal(check.severity, "fail");
  assert.match(check.result, /\/nowhere\/that\/exists/);
  assert.equal(diagnosis.code, 1);
});

test("a workspace whose root is not a string fails rather than dropping the check", async () => {
  for (const declared of [5, null, [], {}]) {
    const dir = healthy();
    describe(dir, { root: declared, idPrefix: "doc", lockPrefix: "doctor", repos: {} });
    const diagnosis = await diagnose(options([dir]));
    const check = named(diagnosis, `${basename(dir)} root`);
    assert.equal(check.severity, "fail");
    assert.ok(check.tried.includes(WORKSPACE_FILE), `tried does not name the file: ${check.tried}`);
    assert.ok(
      check.result.includes(JSON.stringify(declared)),
      `result does not say what it found: ${check.result}`,
    );
    assert.equal(named(diagnosis, `${basename(dir)} tracker`).severity, "ok");
    assert.equal(diagnosis.code, 1);
  }
});

test("a root with no tracker fails, because an empty screen is what that looks like", async () => {
  const dir = root();
  checkout(dir, "cli");
  describe(dir, { root: dir, idPrefix: "doc", lockPrefix: "doctor", repos: { site: { path: "cli" } } });
  const diagnosis = await diagnose(options([dir]));
  assert.equal(named(diagnosis, `${basename(dir)} tracker`).severity, "fail");
  assert.equal(diagnosis.code, 1);
});

test("a root that does not exist fails rather than reporting nothing", async () => {
  const missing = join(root(), "gone");
  const diagnosis = await diagnose(options([missing]));
  const check = named(diagnosis, "gone");
  assert.equal(check.severity, "fail");
  assert.match(check.tried, new RegExp(missing));
  assert.equal(diagnosis.code, 1);
});

test("a root holding no workspace file names both filenames it looked for", async () => {
  const dir = root();
  const diagnosis = await diagnose(options([dir]));
  const check = named(diagnosis, basename(dir));
  assert.equal(check.severity, "fail");
  assert.match(check.result, /\.pitwall\.json or \.autofix\.json/);
});

test("no roots at all fails and says where it looked", async () => {
  const place = options([]);
  const diagnosis = await diagnose(place);
  const check = named(diagnosis, "roots");
  assert.equal(check.severity, "fail");
  assert.match(check.result, /0 workspace roots/);
  assert.equal(diagnosis.code, 1);
});

test("a workspace with no lockPrefix warns that no lane will be reported", async () => {
  const dir = root();
  tracker(dir);
  describe(dir, { root: dir, idPrefix: "doc", repos: {} });
  const diagnosis = await diagnose(options([dir]));
  const check = named(diagnosis, `${basename(dir)} lanes`);
  assert.equal(check.severity, "warn");
  assert.match(check.result, /no lockPrefix/);
  assert.equal(diagnosis.code, 0);
});

test("a workspace file that is not JSON fails with what the parser said", async () => {
  const dir = root();
  tracker(dir);
  writeFileSync(join(dir, WORKSPACE_FILE), '{ "repos": {');
  const diagnosis = await diagnose(options([dir]));
  assert.equal(named(diagnosis, basename(dir)).severity, "fail");
  assert.equal(diagnosis.code, 1);
});

test("a workspace whose repos is not an object fails without abandoning the rest of the report", async () => {
  for (const repos of [[], null]) {
    const broken = root();
    tracker(broken);
    writeFileSync(join(broken, WORKSPACE_FILE), JSON.stringify({ root: broken, repos }));
    const well = healthy("own");
    const diagnosis = await diagnose(options([broken, well]));
    const check = named(diagnosis, basename(broken));
    assert.equal(check.severity, "fail");
    assert.ok(check.result.includes("repos is not an object"));
    assert.ok(check.tried.includes(broken));
    assert.equal(named(diagnosis, `${basename(well)} tracker`).severity, "ok");
    assert.equal(named(diagnosis, `${basename(well)} repo site`).severity, "ok");
    assert.equal(diagnosis.code, 1);
  }
});

test("the same root listed twice is checked once and is reported as listed twice", async () => {
  const dir = healthy();
  const twice = await diagnose(options([dir, dir]));
  assert.equal(twice.checks.filter((check) => check.name === basename(dir)).length, 1);
  assert.equal(named(twice, "lockPrefix").severity, "ok");
  const repeated = named(twice, `${basename(dir)} listed`);
  assert.equal(repeated.severity, "fail");
  assert.ok(repeated.result.includes(dir), `result does not name the root: ${repeated.result}`);
  assert.match(repeated.result, /listed 2 times/);
  assert.match(repeated.result, /the console reports this workspace 2 times/);
  assert.equal(twice.code, 1);
  const once = await diagnose(options([dir]));
  assert.equal(once.checks.filter((check) => check.name.endsWith(" listed")).length, 0);
  assert.equal(once.code, 0);
});

test("the report prints one line per check, plus a header and a count", () => {
  const checks: Check[] = [
    { severity: "ok", name: "roots", tried: "read /config", result: "1 workspace root" },
    { severity: "warn", name: "gh", tried: "gh auth status", result: "gh is not on PATH" },
    { severity: "fail", name: "here bd", tried: "bd statuses --json", result: "bd is not on PATH" },
  ];
  const out = renderDoctor({ checks, code: 1 });
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.filter((line) => /^ {2}(ok|warn|fail) /.test(line)).length, 3);
  assert.match(lines[0] ?? "", /^pitwall .* doctor$/);
  assert.match(out, /1 failed · 1 warned · 3 checked/);
  assert.doesNotMatch(out, /\[/);
});

test("the report says nothing to fix when nothing is wrong", () => {
  const checks: Check[] = [
    { severity: "ok", name: "roots", tried: "read /config", result: "1 workspace root" },
  ];
  assert.match(renderDoctor({ checks, code: 0 }), /1 checked · nothing to fix\./);
});

test("colour is off unless it is asked for", () => {
  const checks: Check[] = [
    { severity: "fail", name: "roots", tried: "read /config", result: "0 workspace roots" },
  ];
  assert.match(renderDoctor({ checks, code: 1 }, { color: true }), /\[31m/);
});
