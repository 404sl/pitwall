import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { INTAKE_LABEL } from "../src/intake.ts";
import { slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const QUEUE_SH = join(SKILL, "queue.sh");

type Issue = { id: string; title: string; assignee: string | null; labels?: readonly string[]; priority?: number };

type Bd = { bin: string; log: string };

function payloadOf(issues: readonly Issue[], status: string): string {
  return JSON.stringify(
    issues.map((i) => ({
      id: i.id,
      title: i.title,
      description: "",
      priority: i.priority ?? 2,
      status,
      issue_type: "task",
      labels: i.labels ?? [],
      assignee: i.assignee,
      created_at: "2026-09-12T00:00:00Z",
      updated_at: new Date().toISOString(),
    })),
  );
}

function stubBd(open: readonly Issue[], running: readonly Issue[] = []): Bd {
  const payload = payloadOf(open, "open");
  const inflight = payloadOf(running, "in_progress");
  const bin = mkdtempSync(join(tmpdir(), "pitwall-queue-refine-bin-"));
  const log = join(bin, "calls.log");
  const stub = join(bin, "bd");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      "  *'--status open --json'*)",
      "    cat <<'JSON'",
      payload,
      "JSON",
      "    ;;",
      "  *'--status in_progress --json'*)",
      "    cat <<'JSON'",
      inflight,
      "JSON",
      "    ;;",
      "  *) echo '[]' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { bin, log };
}

function workspace(config: Record<string, unknown>, lockPrefix: string): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-queue-refine-"));
  writeFileSync(
    join(root, ".pitwall.json"),
    `${JSON.stringify({ root, idPrefix: "fixture", lockPrefix, repos: {}, ...config })}\n`,
  );
  return root;
}

const ISSUES: readonly Issue[] = [
  { id: "fixture-task", title: "a ticket for the loop", assignee: "fixture-devloop", priority: 2 },
  { id: "fixture-req", title: "the board is unreadable", assignee: "fixture-planning-session", labels: [INTAKE_LABEL], priority: 2 },
  { id: "fixture-asked", title: "a request waiting on an answer", assignee: "fixture-planning-session", labels: [INTAKE_LABEL, "needs-decision"], priority: 1 },
];

function runQueue(root: string, bd: Bd, args: readonly string[] = []): { status: number; out: string; err: string } {
  const ran = spawnSync("bash", [QUEUE_SH, ...args], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: root,
      PITWALL_CONFIG: undefined,
      DEVLOOP_CONFIG: undefined,
      BEADS_ACTOR: undefined,
      PATH: `${bd.bin}:${process.env["PATH"] ?? ""}`,
    },
  });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function calls(bd: Bd): readonly string[] {
  return existsSync(bd.log) ? readFileSync(bd.log, "utf8").trim().split("\n") : [];
}

function section(out: string, heading: string): string {
  const start = out.indexOf(` ${heading}\n`);
  assert.notEqual(start, -1, `no ${heading} section in:\n${out}`);
  const rest = out.slice(start + heading.length + 2);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

test("queue.sh counts a recorded request apart from the tickets, and never as a task", () => {
  const bd = stubBd(ISSUES);
  const prefix = `pitwallqueuereq${process.pid}`;
  const { status, out, err } = runQueue(workspace({ actor: "fixture-devloop" }, prefix), bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /ready to start\s+1\s+assigned to fixture-devloop/, "the request was counted as a ticket the loop can start");
  assert.match(out, /to refine\s+1\s+requests recorded as typed/);
  const next = section(out, "NEXT UP");
  assert.match(next, /fixture-req\b.*\brefine$/m, "the request is not offered as a refine");
  assert.match(next, /fixture-task\b/);
  assert.doesNotMatch(next, /fixture-asked/, "a request parked on a question was offered for refinement before the answer");
  assert.match(section(out, "WAITING ON YOU"), /fixture-asked\b.*\[needs-decision\]/);
});

test("queue.sh --next hands a request out as a refine line, claimed by status alone", () => {
  const bd = stubBd(ISSUES);
  const prefix = `pitwallqueuereqnext${process.pid}`;
  const slots = slotsPath(prefix);
  try {
    const { status, out, err } = runQueue(workspace({ actor: "fixture-devloop" }, prefix), bd, ["--next", "2"]);

    assert.equal(status, 0, `${out}${err}`);
    assert.match(out, /^fixture-req \d+ refine$/m, `no refine line in:\n${out}`);
    assert.match(out, /^fixture-task \d+$/m);
    assert.doesNotMatch(out, /^fixture-asked /m);
    const writes = calls(bd).filter((c) => c.includes("update"));
    assert.ok(
      writes.includes("--actor fixture-devloop update fixture-req -s in_progress"),
      `the request is claimed with --claim, which bd refuses for an issue intake assigned to the planning session:\n${writes.join("\n")}`,
    );
    assert.ok(writes.includes("--actor fixture-devloop update fixture-task --claim"));
    assert.equal(writes.some((c) => c.includes("fixture-req --claim")), false);
  } finally {
    rmSync(slots, { recursive: true, force: true });
  }
});

test("queue.sh counts a refine in flight as running, though it holds no worktree", () => {
  const bd = stubBd(
    [{ id: "fixture-task", title: "a ticket for the loop", assignee: "fixture-devloop" }],
    [{ id: "fixture-refining", title: "being refined", assignee: "fixture-planning-session", labels: [INTAKE_LABEL] }],
  );
  const { status, out, err } = runQueue(workspace({ actor: "fixture-devloop" }, `pitwallqueuereqrun${process.pid}`), bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /running now\s+1\s*$/m, "a refine in flight was read as handed off, so the loop would dispatch over it");
  assert.doesNotMatch(out, /awaiting lander/);
  assert.match(section(out, "IN FLIGHT"), /fixture-refining/);
});

test("queue.sh neither claims nor hands out a request when the workspace declares no actor", () => {
  const bd = stubBd(ISSUES);
  const prefix = `pitwallqueuereqnoactor${process.pid}`;
  const slots = slotsPath(prefix);
  try {
    const { status, out, err } = runQueue(workspace({}, prefix), bd, ["--next", "3"]);

    assert.equal(status, 0, `${out}${err}`);
    assert.match(out, /ready to start\s+1\s*$/m);
    assert.match(out, /to refine\s+1\s+.*declares "actor"/, "the request is not counted with the reason it cannot move");
    assert.doesNotMatch(out, /^fixture-req /m, "a refine line was printed that config.sh --refine will refuse for want of an actor");
    assert.equal(
      calls(bd).some((c) => c.includes("fixture-req")),
      false,
      "the request was claimed in_progress with no actor to dispatch it under, so it sits claimed with a slot until somebody reopens it",
    );
    assert.match(out, /^fixture-task \d+$/m);
  } finally {
    rmSync(slots, { recursive: true, force: true });
  }
});
