import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const QUEUE_SH = join(SKILL, "queue.sh");

type Issue = { id: string; title: string; assignee: string | null; labels?: readonly string[] };

type Bd = { bin: string; log: string };

function stubBd(open: readonly Issue[]): Bd {
  const payload = JSON.stringify(
    open.map((i) => ({
      id: i.id,
      title: i.title,
      description: "",
      priority: 1,
      status: "open",
      issue_type: "task",
      labels: i.labels ?? [],
      assignee: i.assignee,
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
    })),
  );
  const bin = mkdtempSync(join(tmpdir(), "pitwall-queue-bin-"));
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
      "  *) echo '[]' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { bin, log };
}

function workspace(config: Record<string, unknown>, lockPrefix: string): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-queue-assignee-"));
  writeFileSync(
    join(root, ".pitwall.json"),
    `${JSON.stringify({ root, idPrefix: "fixture", lockPrefix, repos: {}, ...config })}\n`,
  );
  return root;
}

const ISSUES: readonly Issue[] = [
  { id: "fixture-mine", title: "assigned to the loop", assignee: "fixture-devloop" },
  { id: "fixture-theirs", title: "assigned to a person", assignee: "fixture-planning-session" },
  { id: "fixture-nobodys", title: "assigned to nobody", assignee: null },
];

function runQueue(
  root: string,
  bd: Bd,
  args: readonly string[] = [],
): { status: number; out: string; err: string } {
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

test("queue.sh counts the whole ready queue when no actor is declared", () => {
  const bd = stubBd(ISSUES);
  const { status, out, err } = runQueue(workspace({}, `pitwallqueueoff${process.pid}`), bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /ready to start\s+3\s*$/m);
  assert.match(out, /fixture-theirs/);
});

test("queue.sh applies the same assignee gate dispatchable.sh does, and says which queue it counted", () => {
  const bd = stubBd(ISSUES);
  const { status, out, err } = runQueue(
    workspace({ actor: "fixture-devloop" }, `pitwallqueueon${process.pid}`),
    bd,
  );

  assert.equal(status, 0, `${out}${err}`);
  assert.match(
    out,
    /ready to start\s+1\s+assigned to fixture-devloop/,
    "watch.sh builds its DISPATCH line from this number, so it has to mean what dispatchable.sh offers",
  );
  assert.match(out, /fixture-mine/);
  assert.doesNotMatch(out, /fixture-theirs/);
  assert.doesNotMatch(out, /fixture-nobodys/);
});

test("queue.sh --next claims as the actor it filtered on", () => {
  const bd = stubBd(ISSUES);
  const { status, out, err } = runQueue(
    workspace({ actor: "fixture-devloop" }, `pitwallqueuenext${process.pid}`),
    bd,
    ["--next", "1"],
  );

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /^fixture-mine \d+$/m);
  const claim = calls(bd).find((c) => c.includes("--claim"));
  assert.equal(
    claim,
    "--actor fixture-devloop update fixture-mine --claim",
    "a claim that does not carry the actor is refused by bd's own ownership guard, so the queue counts work it then cannot hand out",
  );
});

const PARK_LABELS = [
  "needs-decision",
  "needs-access",
  "needs-feedback",
  "blocked-tooling",
  "watch",
  "umbrella",
  "roadmap",
] as const;

const PARKED: readonly Issue[] = [
  { id: "fixture-free", title: "carries no label", assignee: null },
  ...PARK_LABELS.map((label) => ({ id: `fixture-${label}`, title: `parked with ${label}`, assignee: null, labels: [label] })),
];

function section(out: string, heading: string): string {
  const start = out.indexOf(` ${heading}\n`);
  assert.notEqual(start, -1, `no ${heading} section in:\n${out}`);
  const rest = out.slice(start + heading.length + 2);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

test("queue.sh parks every label the skill tells a person to write, needs-feedback included", () => {
  const bd = stubBd(PARKED);
  const { status, out, err } = runQueue(workspace({}, `pitwallqueuepark${process.pid}`), bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /ready to start\s+1\s*$/m);
  const next = section(out, "NEXT UP");
  const waiting = section(out, "WAITING ON YOU");
  assert.match(next, /fixture-free/);
  for (const label of PARK_LABELS) {
    assert.doesNotMatch(next, new RegExp(`fixture-${label}\\b`), `${label} was offered as ready work`);
    assert.match(waiting, new RegExp(`fixture-${label}\\b.*\\[${label}\\]`), `${label} is not listed as waiting on a person`);
  }
  assert.match(out, /needs-feedback\s+1\s+/, "a needs-feedback issue is somebody's question, not an unexplained park");
  assert.doesNotMatch(out, /parked: needs-feedback/);
});

test("queue.sh --next never claims an issue labelled needs-feedback", () => {
  const bd = stubBd(PARKED);
  const { status, out, err } = runQueue(
    workspace({}, `pitwallqueueparknext${process.pid}`),
    bd,
    ["--next", String(PARKED.length)],
  );

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /^fixture-free \d+$/m);
  const claimed = calls(bd).filter((c) => c.includes("--claim"));
  assert.deepEqual(claimed, ["update fixture-free --claim"]);
  for (const label of PARK_LABELS) {
    assert.doesNotMatch(out, new RegExp(`^fixture-${label} \\d+$`, "m"), `${label} was handed out`);
  }
});
