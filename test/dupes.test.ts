import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const DUPES_SH = join(SKILL, "dupes.sh");

function runDupesScript(cwd: string, extraPath?: string): { status: number; out: string; err: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DEVLOOP_ROOT: cwd,
    PITWALL_CONFIG: undefined,
    DEVLOOP_CONFIG: undefined,
    LOCK_PREFIX: undefined,
  };
  if (extraPath !== undefined) {
    env["PATH"] = `${extraPath}:${process.env["PATH"] ?? ""}`;
  }
  const ran = spawnSync("bash", [DUPES_SH], { encoding: "utf8", cwd, env });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function emptyBd(): string {
  const bin = mkdtempSync(join(tmpdir(), "pitwall-dupes-bin-"));
  const stub = join(bin, "bd");
  writeFileSync(stub, "#!/bin/sh\necho '[]'\n");
  chmodSync(stub, 0o755);
  return bin;
}

function scratchPaths(prefix: string): string[] {
  return ["open", "closed", "running"].map((kind) => `/tmp/${prefix}-dupes-${kind}.json`);
}

test("dupes.sh refuses rather than scoring another workspace's issues as this one's", () => {
  const root = mkdtempSync(join(tmpdir(), "pitwall-dupes-noconfig-"));

  const { status, out, err } = runDupesScript(root);

  assert.equal(status, 6, `${out}${err}`);
  assert.match(err, /refusing to guess/);
  assert.doesNotMatch(out, /workable open issues/);
  assert.match(err, /^dupes\.sh: /);
});

test("dupes.sh names its scratch files after the lockPrefix the workspace config declares", () => {
  const root = mkdtempSync(join(tmpdir(), "pitwall-dupes-config-"));
  const prefix = `pitwalldupes${process.pid}`;
  writeFileSync(
    join(root, ".autofix.json"),
    `${JSON.stringify({ root, idPrefix: "fixture", lockPrefix: prefix, repos: {} })}\n`,
  );

  try {
    const { status, out, err } = runDupesScript(root, emptyBd());

    assert.equal(status, 0, `${out}${err}`);
    assert.match(out, /workable open issues/);
    for (const path of scratchPaths(prefix)) {
      assert.ok(existsSync(path), `dupes.sh wrote no ${path}, so the prefix did not come from the config`);
    }
  } finally {
    for (const path of scratchPaths(prefix)) {
      rmSync(path, { force: true });
    }
  }
});

test("no script in the skill defaults the lock prefix to the literal devloop", () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(SKILL)) {
    if (!/\.(sh|js)$/.test(entry)) continue;
    const text = readFileSync(join(SKILL, entry), "utf8");
    for (const line of text.split("\n")) {
      if (line.includes(":-devloop")) offenders.push(`${entry}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a script defaults the lock prefix instead of refusing to guess, so it reports on whichever workspace happens to own that name:\n${offenders.join("\n")}`,
  );
});
