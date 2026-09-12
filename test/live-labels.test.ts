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

interface Run {
  transcript: string;
  labels?: readonly string[];
}

interface Shape {
  idPrefix: string;
  runs: Record<string, Run>;
}

interface Result {
  stdout: string;
  stderr: string;
  status: number | null;
}

function live(shape: Shape): Result {
  const root = mkdtempSync(join(tmpdir(), "pitwall-live-labels-"));
  const skill = join(root, "skill");
  const wf = join(root, "projects");
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
      `  idPrefix) echo ${JSON.stringify(shape.idPrefix)} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  for (const [run, { transcript, labels }] of Object.entries(shape.runs)) {
    const dir = join(wf, run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-a1.jsonl"), `${JSON.stringify({ type: "user", message: transcript })}\n`);
    if (labels !== undefined) {
      const lines = [
        JSON.stringify({ type: "launched" }),
        ...labels.map((label) => JSON.stringify({ type: "started", agentId: "a1", label, phase: "Fix" })),
      ];
      writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
    }
  }
  const ran = spawnSync("bash", [join(skill, "live.sh")], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...GIT_ENV, DEVLOOP_ROOT: root, DEVLOOP_WF: wf, DEVLOOP_TASKS: tasks },
  });
  return { stdout: `${ran.stdout ?? ""}`.trim(), stderr: `${ran.stderr ?? ""}`.trim(), status: ran.status };
}

test("a run is named by its journal label when the first prefixed token in its transcript is a lock path", () => {
  const out = live({
    idPrefix: "pitwall",
    runs: {
      wf_f548a206: {
        labels: ["triage:pitwall-76x", "fix:pitwall-76x", "review:pitwall-76x", "fix:pitwall-76x#2"],
        transcript: "Slot 2 held at /tmp/pitwall-lane-2.lock.\n\nIssue: pitwall-76x - queue-watch.sh id patterns",
      },
    },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_f548a206 +pitwall-76x +(idle|working) /m);
  assert.doesNotMatch(out.stdout, /pitwall-lane/);
});

test("a lander, whose labels carry no issue id, is marked as such rather than named after a repository", () => {
  const out = live({
    idPrefix: "pitwall",
    runs: {
      wf_4ce8a2cf: {
        labels: ["lock", "survey", "survey#2", "land:404sl/pitwall#135", "version:404sl/pitwall#135", "deploy:3"],
        transcript: "Merge lock at /tmp/pitwall-merge.lock. The contract lives in pitwall-schema, the CLI in pitwall.",
      },
    },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_4ce8a2cf +no id in its labels +(idle|working) /m);
  assert.doesNotMatch(out.stdout, /pitwall-schema|pitwall-merge|404sl/);
});

test("a run with no journal falls back to the transcript grep", () => {
  const out = live({
    idPrefix: "sr",
    runs: { wf_aaa: { transcript: "Issue: sr-abc - no journal written yet" } },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_aaa +sr-abc +(idle|working) /m);
});

test("a journal that has launched but labelled nothing yet leaves the transcript fallback in place", () => {
  const out = live({
    idPrefix: "sr",
    runs: { wf_bbb: { labels: [], transcript: "Issue: sr-4b5.1 - just launched" } },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_bbb +sr-4b5\.1 +(idle|working) /m);
});

test("a run with no journal and no id in its transcript keeps its UNKNOWN row", () => {
  const out = live({
    idPrefix: "pitwall",
    runs: { wf_ccc: { transcript: "nothing here names an issue" } },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_ccc +UNKNOWN - could not identify/m);
});
