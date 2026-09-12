import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const DISPATCHABLE_SH = join(SKILL, "dispatchable.sh");

type Issue = {
  id: string;
  title: string;
  assignee: string | null;
  labels?: readonly string[];
};

type Run = { status: number; out: string; err: string };

function runDispatchable(cwd: string, extraPath: string, declareRoot = true): Run {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    DEVLOOP_ROOT: declareRoot ? cwd : undefined,
    PITWALL_CONFIG: undefined,
    DEVLOOP_CONFIG: undefined,
    LOCK_PREFIX: undefined,
    PATH: `${extraPath}:${process.env["PATH"] ?? ""}`,
  };
  const ran = spawnSync("bash", [DISPATCHABLE_SH], { encoding: "utf8", cwd, env });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function stubBd(issues: readonly Issue[]): string {
  const payload = JSON.stringify(
    issues.map((i) => ({
      id: i.id,
      title: i.title,
      description: "",
      priority: 1,
      status: "open",
      issue_type: "task",
      labels: i.labels ?? [],
      assignee: i.assignee,
    })),
  );
  const bin = mkdtempSync(join(tmpdir(), "pitwall-dispatchable-bin-"));
  const stub = join(bin, "bd");
  writeFileSync(stub, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`);
  chmodSync(stub, 0o755);
  return bin;
}

function workspace(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-dispatchable-"));
  writeFileSync(
    join(root, ".pitwall.json"),
    `${JSON.stringify({
      root,
      idPrefix: "fixture",
      lockPrefix: `pitwalldispatch${process.pid}`,
      repos: {},
      ...config,
    })}\n`,
  );
  return root;
}

test("dispatchable.sh leaves the assignee gate off for a workspace that declares no actor", () => {
  const root = workspace({});
  const bd = stubBd([
    { id: "fixture-mine", title: "assigned to a loop", assignee: "fixture-devloop" },
    { id: "fixture-theirs", title: "assigned to a person", assignee: "fixture-planning-session" },
    { id: "fixture-nobodys", title: "assigned to nobody", assignee: null },
  ]);

  const { status, out, err } = runDispatchable(root, bd);

  assert.equal(status, 0, `${out}${err}`);
  for (const id of ["fixture-mine", "fixture-theirs", "fixture-nobodys"]) {
    assert.match(
      out,
      new RegExp(id),
      "a workspace that assigns nothing lost its whole backlog to a gate it never asked for",
    );
  }
  assert.match(err, /assignee gate OFF/);
  assert.match(err, /"actor"/, "the notice does not say how to turn the gate on");
});

test("dispatchable.sh offers only the declared actor's work once the workspace opts in", () => {
  const root = workspace({ actor: "fixture-devloop" });
  const bd = stubBd([
    { id: "fixture-mine", title: "assigned to the loop", assignee: "fixture-devloop" },
    { id: "fixture-theirs", title: "assigned to a person", assignee: "fixture-planning-session" },
    { id: "fixture-nobodys", title: "assigned to nobody", assignee: null },
  ]);

  const { status, out, err } = runDispatchable(root, bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(out, /fixture-mine/);
  assert.doesNotMatch(
    out,
    /fixture-theirs/,
    "a ticket sitting in the planning session's queue was offered for dispatch",
  );
  assert.doesNotMatch(out, /fixture-nobodys/, "an unassigned ticket was offered for dispatch");
  assert.doesNotMatch(err, /assignee gate OFF/);
});

test("dispatchable.sh never derives the queue name from the id prefix", () => {
  const root = workspace({ idPrefix: "sr", actor: "session-replay-devloop" });
  const bd = stubBd([
    { id: "sr-declared", title: "the declared queue", assignee: "session-replay-devloop" },
    { id: "sr-derived", title: "the id prefix plus -devloop", assignee: "sr-devloop" },
  ]);

  const { status, out, err } = runDispatchable(root, bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(
    out,
    /sr-declared/,
    "a workspace whose id prefix is not its project name was offered none of its own work",
  );
  assert.doesNotMatch(out, /sr-derived/);
});

test("dispatchable.sh counts only work the assignee gate itself withheld", () => {
  const root = workspace({ actor: "fixture-devloop" });
  const bd = stubBd([
    { id: "fixture-theirs", title: "assigned to a person", assignee: "fixture-planning-session" },
    {
      id: "fixture-parked",
      title: "parked and assigned to a person",
      assignee: "fixture-planning-session",
      labels: ["needs-decision"],
    },
  ]);

  const { status, out, err } = runDispatchable(root, bd);

  assert.equal(status, 0, `${out}${err}`);
  assert.match(
    out,
    /fixture-planning-session \(1\)/,
    "the count of work held elsewhere included a ticket that was parked anyway",
  );
});

test("dispatchable.sh refuses rather than guessing whose workspace it is reading", () => {
  const root = mkdtempSync(join(tmpdir(), "pitwall-dispatchable-noconfig-"));

  const { status, out, err } = runDispatchable(root, stubBd([]), false);

  assert.equal(status, 6, `${out}${err}`);
  assert.match(
    err,
    /no \.pitwall\.json or \.autofix\.json found/,
    "the refusal names a config field rather than the missing config file",
  );
  assert.match(err, /refusing to guess/);
});
