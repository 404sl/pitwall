import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const QUEUE_SH = join(SKILL, "queue.sh");

type Issue = { id: string; title: string; assignee: string | null };

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
      labels: [],
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
