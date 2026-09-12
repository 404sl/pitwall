import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

interface Shape {
  idPrefix?: string;
  inProgress: readonly string[];
  liveTranscript: string;
}

interface Space {
  root: string;
  skill: string;
  pfx: string;
}

let serial = 0;

function workspace(shape: Shape): Space {
  const root = mkdtempSync(join(tmpdir(), "pitwall-triage-scan-"));
  const skill = join(root, "skill");
  const bin = join(root, "bin");
  const pfx = `pitwalltriagescan${process.pid}x${serial++}`;
  mkdirSync(skill);
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  writeFileSync(join(skill, "triage-scan.sh"), readFileSync(join(SKILL, "triage-scan.sh"), "utf8"));
  const idPrefix = shape.idPrefix === undefined ? "exit 1" : `echo ${JSON.stringify(shape.idPrefix)}`;
  writeFileSync(
    join(skill, "config.sh"),
    [
      "#!/bin/bash",
      'case "${1:-}" in',
      `  root) echo ${JSON.stringify(root)} ;;`,
      `  idPrefix) ${idPrefix} ;;`,
      `  lockPrefix) echo ${pfx} ;;`,
      `  "") printf '%s\\n' '${JSON.stringify({ root, repos: {} })}' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const issues = JSON.stringify(
    shape.inProgress.map((id) => ({
      id,
      title: `work on ${id}`,
      description: "",
      notes: "",
      priority: 2,
      status: "in_progress",
      issue_type: "task",
      labels: [],
    })),
  );
  writeFileSync(
    join(bin, "bd"),
    [
      "#!/bin/bash",
      'case " $* " in',
      '  *" open "*|*" closed "*) echo "[]" ;;',
      `  *) cat <<'JSON'`,
      issues,
      "JSON",
      "  ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "bd"), 0o755);
  const wf = join(root, ".claude", "projects", root.replace(/\//g, "-"), "run-1");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "transcript.jsonl"), `${shape.liveTranscript}\n`);
  return { root, skill, pfx };
}

function scan(space: Space): { stdout: string; stderr: string; status: number | null } {
  const ran = spawnSync("bash", [join(space.skill, "triage-scan.sh")], {
    encoding: "utf8",
    cwd: space.root,
    timeout: 60_000,
    env: {
      ...process.env,
      ...GIT_ENV,
      HOME: space.root,
      DEVLOOP_ROOT: space.root,
      TRIAGE_MARK: undefined,
      PATH: `${join(space.root, "bin")}:${process.env["PATH"] ?? ""}`,
    },
  });
  for (const f of ["all", "open", "run", "closed"]) rmSync(`/tmp/${space.pfx}-ts-${f}.json`, { force: true });
  return { stdout: `${ran.stdout ?? ""}`, stderr: `${ran.stderr ?? ""}`, status: ran.status };
}

function staleWorktree(space: Space, id: string): string {
  const wt = join("/private/tmp", `${space.pfx}-worktrees`, id);
  mkdirSync(wt, { recursive: true });
  const old = new Date(Date.now() - 45 * 60_000);
  utimesSync(wt, old, old);
  return join("/private/tmp", `${space.pfx}-worktrees`);
}

const TRANSCRIPT = JSON.stringify({ role: "user", text: "Issue: pitwall-abc - fix the thing. Branch: devloop/pitwall-abc" });

test("an in_progress issue a live run names under the workspace's own id prefix is not a stale claim", () => {
  const space = workspace({ idPrefix: "pitwall", inProgress: ["pitwall-abc", "pitwall-dead"], liveTranscript: TRANSCRIPT });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-dead P2/m);
  assert.doesNotMatch(out.stdout, /pitwall-abc/);
});

test(
  "an in_progress issue whose worktree is untouched for 30+ min but which a live run names is not reported under G",
  { skip: !existsSync("/private/tmp") },
  () => {
    const space = workspace({ idPrefix: "pitwall", inProgress: ["pitwall-abc", "pitwall-dead"], liveTranscript: TRANSCRIPT });
    const worktrees = staleWorktree(space, "pitwall-abc");
    staleWorktree(space, "pitwall-dead");
    try {
      const out = scan(space);
      assert.equal(out.status, 1, out.stderr);
      assert.match(out.stdout, /^\[G lane died holding its worktree\] pitwall-dead P2/m);
      assert.doesNotMatch(out.stdout, /pitwall-abc/);
    } finally {
      rmSync(worktrees, { recursive: true, force: true });
    }
  },
);

test("triage-scan.sh refuses to scan when idPrefix cannot be resolved", () => {
  const space = workspace({ inProgress: ["pitwall-abc"], liveTranscript: TRANSCRIPT });
  const out = scan(space);
  assert.equal(out.status, 3);
  assert.match(out.stderr, /idPrefix/);
  assert.equal(out.stdout, "");
});

test("no id prefix literal remains in _live_ids", () => {
  const src = readFileSync(join(SKILL, "triage-scan.sh"), "utf8");
  const start = src.indexOf("def _live_ids():");
  const end = src.indexOf("\n\n#", start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(src.slice(start, end), /sr-/);
});
