import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

function run(script: string, args: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "pitwall-flag-values-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    DEVLOOP_ROOT: root,
    PITWALL_CONFIG: undefined,
    DEVLOOP_CONFIG: undefined,
    LOCK_PREFIX: undefined,
  };
  const ran = spawnSync("bash", [join(SKILL, script), ...args], { encoding: "utf8", cwd: root, env, timeout: 30_000 });
  return { status: ran.status ?? -1, signal: ran.signal, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function refusesTrailing(script: string, leading: readonly string[], flags: readonly string[]): void {
  for (const flag of flags) {
    const { status, signal, out, err } = run(script, [...leading, flag]);

    assert.equal(signal, null, `${script} ${flag}: the script had to be killed`);
    assert.equal(status, 6, `${script} ${flag}: ${out}${err}`);
    assert.match(err, new RegExp(`${flag} needs a value`));
  }
}

test("land-one.sh refuses a value-taking flag given no value instead of looping on it forever", () => {
  refusesTrailing(
    "land-one.sh",
    ["--repo-path", "/nowhere", "--slug", "acme/site", "--pr", "1", "--branch", "lane/x"],
    ["--repo-path", "--slug", "--pr", "--branch", "--prefix", "--label", "--register-wait", "--register-interval", "--checks-wait"],
  );
});

test("land-train.sh refuses a value-taking flag given no value instead of looping on it forever", () => {
  refusesTrailing(
    "land-train.sh",
    ["--repo-path", "/nowhere", "--slug", "acme/site"],
    ["--repo-path", "--slug", "--label", "--max", "--only", "--suffix", "--prefix"],
  );
});

test("stranded.sh refuses --repo with no value instead of looping on it forever", () => {
  refusesTrailing("stranded.sh", [], ["--repo"]);
});
