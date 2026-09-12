import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV } from "./support/git.js";

const SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
);

interface Space {
  root: string;
  skill: string;
  wf: string;
  tasks: string;
}

function workspace(projects = "projects"): Space {
  const root = mkdtempSync(join(tmpdir(), "pitwall-live-layout-"));
  const skill = join(root, "skill");
  const wf = join(root, projects);
  const tasks = join(root, "tasks");
  mkdirSync(skill);
  mkdirSync(wf);
  mkdirSync(tasks);
  writeFileSync(join(skill, "live.sh"), readFileSync(join(SKILL, "live.sh"), "utf8"));
  writeFileSync(
    join(skill, "config.sh"),
    [
      "#!/bin/bash",
      'case "${1:-}" in',
      `  root) echo ${JSON.stringify(root)} ;;`,
      '  idPrefix) echo "sr" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  return { root, skill, wf, tasks };
}

function run(space: Space, dir: string, id: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ type: "started" })}\n`);
  writeFileSync(
    join(dir, "agent-a1.jsonl"),
    `${JSON.stringify({ type: "user", message: `Issue: ${id} - fix it` })}\n`,
  );
}

function nested(space: Space, session: string, name: string, id: string): void {
  run(space, join(space.wf, session, "subagents", "workflows", name), id);
  writeFileSync(join(space.wf, `${session}.jsonl`), `${JSON.stringify({ type: "user" })}\n`);
}

function flat(space: Space, name: string, id: string): void {
  run(space, join(space.wf, name), id);
}

function live(space: Space): { stdout: string; stderr: string; status: number | null } {
  const ran = spawnSync("bash", [join(space.skill, "live.sh")], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: space.root,
      DEVLOOP_WF: space.wf,
      DEVLOOP_TASKS: space.tasks,
    },
  });
  return { stdout: `${ran.stdout ?? ""}`.trim(), stderr: `${ran.stderr ?? ""}`.trim(), status: ran.status };
}

test("a run under a session's subagents/workflows is named with its id", () => {
  const space = workspace();
  nested(space, "11111111-aaaa-4bbb-8ccc-000000000001", "wf_aaa", "sr-nest1");

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_aaa +sr-nest1 +(idle|working) /m);
  assert.doesNotMatch(out.stdout, /UNKNOWN/);
});

test("runs from several coexisting sessions are all listed", () => {
  const space = workspace();
  nested(space, "11111111-aaaa-4bbb-8ccc-000000000001", "wf_aaa", "sr-one");
  nested(space, "22222222-aaaa-4bbb-8ccc-000000000002", "wf_bbb", "sr-two");

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_aaa +sr-one /m);
  assert.match(out.stdout, /^ {2}wf_bbb +sr-two /m);
});

test("session directories and session transcripts are not reported as runs", () => {
  const space = workspace();
  nested(space, "11111111-aaaa-4bbb-8ccc-000000000001", "wf_aaa", "sr-nest1");

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /11111111-aaaa/);
});

test("a run under the flat layout is still found", () => {
  const space = workspace();
  flat(space, "wf_flat", "sr-flat1");

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_flat +sr-flat1 +(idle|working) /m);
  assert.doesNotMatch(out.stdout, /UNKNOWN/);
});

test("both layouts side by side are both found", () => {
  const space = workspace();
  flat(space, "wf_flat", "sr-flat1");
  nested(space, "11111111-aaaa-4bbb-8ccc-000000000001", "wf_aaa", "sr-nest1");

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_flat +sr-flat1 /m);
  assert.match(out.stdout, /^ {2}wf_aaa +sr-nest1 /m);
});

test("a nested run whose transcript names no id is reported unknown, not dropped", () => {
  const space = workspace();
  const dir = join(space.wf, "11111111-aaaa-4bbb-8ccc-000000000001", "subagents", "workflows", "wf_quiet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ type: "started" })}\n`);

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_quiet +UNKNOWN - could not identify/m);
});

test("a harness directory whose path contains a space still lists every run", () => {
  const space = workspace("my projects");
  flat(space, "wf_flat", "sr-flat1");
  nested(space, "11111111-aaaa-4bbb-8ccc-000000000001", "wf_aaa", "sr-nest1");

  const out = live(space);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_flat +sr-flat1 /m);
  assert.match(out.stdout, /^ {2}wf_aaa +sr-nest1 /m);
  assert.doesNotMatch(out.stdout, /UNKNOWN/);
});
