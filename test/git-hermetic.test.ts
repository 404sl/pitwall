import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV } from "./support/git.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));
const DIRECT = [/\bspawnSync\(\s*"git"/, /\bexecFileSync\(\s*"git"/, /\bexecSync\(\s*["`']git\s/];
const BASH = /\bspawnSync\(\s*"bash"/;

function suite(): { name: string; body: string }[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(".test.ts") && name !== SELF)
    .map((name) => ({ name, body: readFileSync(join(HERE, name), "utf8") }));
}

function hostile(): Record<string, string | undefined> {
  const home = mkdtempSync(join(tmpdir(), "pitwall-hostile-home-"));
  writeFileSync(join(home, ".gitconfig"), "[unclosed\n");
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env["GIT_CONFIG_GLOBAL"];
  delete env["GIT_CONFIG_NOSYSTEM"];
  return env;
}

test("a git child that nulls the global config survives a home config git cannot read", () => {
  const env = hostile();
  const dir = mkdtempSync(join(tmpdir(), "pitwall-hermetic-"));

  const ambient = spawnSync("git", ["init", "--quiet"], { cwd: dir, encoding: "utf8", env });
  assert.notEqual(
    ambient.status,
    0,
    "the hostile home was not hostile, so the rest of this test proves nothing",
  );

  const nulled = spawnSync("git", ["init", "--quiet"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, ...GIT_ENV },
  });
  assert.equal(nulled.status, 0, nulled.stderr);
});

test("no test spawns git itself - they go through the helper that nulls the config", () => {
  const offenders = suite()
    .filter(({ body }) => DIRECT.some((shape) => shape.test(body)))
    .map(({ name }) => name);
  assert.deepEqual(
    offenders,
    [],
    `these spawn git without an explicit config environment: ${offenders.join(", ")}`,
  );
});

test("a test that runs a shell script hands the script a nulled global config", () => {
  const offenders = suite()
    .filter(({ body }) => BASH.test(body) && !body.includes("GIT_ENV"))
    .map(({ name }) => name);
  assert.deepEqual(
    offenders,
    [],
    `these run a script that may reach git on the caller's config: ${offenders.join(", ")}`,
  );
});
