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

interface Shape {
  idPrefix?: string;
  transcripts: Record<string, string>;
}

interface Space {
  root: string;
  skill: string;
  wf: string;
  tasks: string;
}

function workspace(shape: Shape): Space {
  const root = mkdtempSync(join(tmpdir(), "pitwall-live-"));
  const skill = join(root, "skill");
  const wf = join(root, "projects");
  const tasks = join(root, "tasks");
  mkdirSync(skill);
  mkdirSync(wf);
  mkdirSync(tasks);
  writeFileSync(join(skill, "live.sh"), readFileSync(join(SKILL, "live.sh"), "utf8"));
  const idPrefix = shape.idPrefix === undefined ? "exit 1" : `echo ${JSON.stringify(shape.idPrefix)}`;
  writeFileSync(
    join(skill, "config.sh"),
    [
      "#!/bin/bash",
      'case "${1:-}" in',
      `  root) echo ${JSON.stringify(root)} ;;`,
      `  idPrefix) ${idPrefix} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  for (const [run, text] of Object.entries(shape.transcripts)) {
    const dir = join(wf, run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-a1.jsonl"), `${JSON.stringify({ type: "user", message: text })}\n`);
  }
  return { root, skill, wf, tasks };
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

test("a run whose transcript names an issue under the workspace's own id prefix is listed under that id", () => {
  const out = live(
    workspace({
      idPrefix: "pitwall",
      transcripts: { wf_aaa: "Fix one tracker issue end to end.\n\nIssue: pitwall-abc - live.sh reads UNKNOWN" },
    }),
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_aaa +pitwall-abc +(idle|working) /m);
  assert.doesNotMatch(out.stdout, /UNKNOWN/);
});

test("a dotted child id is kept whole", () => {
  const out = live(
    workspace({
      idPrefix: "pitwall",
      transcripts: { wf_bbb: "Issue: pitwall-4b5.1 (child of pitwall-4b5)." },
    }),
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_bbb +pitwall-4b5\.1 /m);
});

test("a run whose transcript names no id under the workspace's prefix is reported as unknown, not dropped", () => {
  const out = live(
    workspace({
      idPrefix: "pitwall",
      transcripts: { wf_ccc: "Issue: sr-abc - somebody else's tracker" },
    }),
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}wf_ccc +UNKNOWN - could not identify/m);
});

test("an unresolvable idPrefix refuses to run rather than scraping for another project's ids", () => {
  const out = live(workspace({ transcripts: { wf_aaa: "Issue: pitwall-abc" } }));
  assert.equal(out.status, 3);
  assert.match(out.stderr, /idPrefix/);
  assert.equal(out.stdout, "");
});

test("live.sh carries no project's id prefix of its own", () => {
  assert.doesNotMatch(readFileSync(join(SKILL, "live.sh"), "utf8"), /sr-/);
});
