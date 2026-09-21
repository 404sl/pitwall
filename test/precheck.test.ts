import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const PRECHECK_SH = join(SKILL, "precheck.sh");

type Issue = { id: string; status: string; labels: string[]; dependency_count: number; title: string; description: string };

function workspace(issues: Issue[]): { root: string; repo: string; bdLog: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "pitwall-precheck-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(join(root, ".beads"));
  writeFileSync(
    join(root, ".autofix.json"),
    `${JSON.stringify({ root, idPrefix: "fixture", lockPrefix: `pitwallprecheck${process.pid}`, repos: {} })}\n`,
  );
  const issuesDir = join(root, "bd-issues");
  mkdirSync(issuesDir);
  for (const issue of issues) {
    writeFileSync(join(issuesDir, `${issue.id}.json`), JSON.stringify([issue]));
  }
  const bdLog = join(root, "bd-calls.log");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = join(bin, "bd");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'printf \'%s %s\\n\' "$PWD" "$BEADS_DIR" >> "$BD_CALL_LOG"',
      'case "$*" in',
      '  "list --status closed --json") echo "[]" ;;',
      '  "show "*" --json") cat "$(dirname "$BEADS_DIR")/bd-issues/$2.json" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { root, repo, bdLog, bin };
}

function runPrecheck(ws: ReturnType<typeof workspace>, id: string): { status: number; out: string; err: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${ws.bin}:${process.env["PATH"] ?? ""}`,
    BD_CALL_LOG: ws.bdLog,
    DEVLOOP_ROOT: undefined,
    PITWALL_CONFIG: undefined,
    DEVLOOP_CONFIG: undefined,
    BEADS_DIR: undefined,
  };
  const ran = spawnSync("bash", [PRECHECK_SH, id], { encoding: "utf8", cwd: ws.repo, env });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

const CLEAN: Issue = {
  id: "fixture-go1",
  status: "open",
  labels: [],
  dependency_count: 0,
  title: "a clean issue",
  description: "nothing parks this one",
};

const PARKED: Issue = {
  id: "fixture-stp1",
  status: "open",
  labels: ["needs-decision"],
  dependency_count: 0,
  title: "a parked issue",
  description: "waiting on a person",
};

test("precheck.sh run from inside a repository resolves the workspace root through config.sh and answers GO", () => {
  const ws = workspace([CLEAN, PARKED]);

  const { status, out, err } = runPrecheck(ws, CLEAN.id);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /^GO {4}fixture-go1: nothing mechanical blocks it/);
  assert.doesNotMatch(err, /command not found/);
  const calls = readFileSync(ws.bdLog, "utf8").trim().split("\n");
  assert.ok(calls.length >= 2, `bd was called ${calls.length} times:\n${calls.join("\n")}`);
  for (const call of calls) {
    assert.equal(call, `${ws.root} ${join(ws.root, ".beads")}`, `bd ran against the wrong tracker: ${call}`);
  }
});

test("precheck.sh answers STOP with the parking label it read from the tracker", () => {
  const ws = workspace([CLEAN, PARKED]);

  const { status, out, err } = runPrecheck(ws, PARKED.id);

  assert.equal(status, 1, `${out}${err}`);
  assert.match(out, /^STOP {2}fixture-stp1: labelled needs-decision/);
  assert.doesNotMatch(out, /bd returned nothing/);
});

test("precheck.sh answers STOP on needs-call, a park that is nobody's question", () => {
  const called: Issue = { ...PARKED, id: "fixture-stp2", labels: ["needs-call"] };
  const ws = workspace([CLEAN, called]);

  const { status, out, err } = runPrecheck(ws, called.id);

  assert.equal(status, 1, `${out}${err}`);
  assert.match(out, /^STOP {2}fixture-stp2: labelled needs-call/);
});

test("precheck.sh refuses rather than reading the nearest tracker when no workspace config is found", () => {
  const ws = workspace([CLEAN]);
  const outside = mkdtempSync(join(tmpdir(), "pitwall-precheck-outside-"));

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${ws.bin}:${process.env["PATH"] ?? ""}`,
    BD_CALL_LOG: ws.bdLog,
    DEVLOOP_ROOT: undefined,
    PITWALL_CONFIG: undefined,
    DEVLOOP_CONFIG: undefined,
  };
  const ran = spawnSync("bash", [PRECHECK_SH, CLEAN.id], { encoding: "utf8", cwd: outside, env });

  assert.equal(ran.status, 6, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stderr, /refusing to guess/);
  assert.doesNotMatch(ran.stdout, /^(GO|STOP)/);
});
