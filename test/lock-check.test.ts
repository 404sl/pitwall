import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV } from "./support/git.js";
import { gnuStatOnPath } from "./support/gnu-stat.js";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "lock-check.sh",
);

interface Workspace {
  root: string;
  home: string;
  lock: string;
}

function workspace(): Workspace {
  const prefix = `fixture-${process.pid}-${Date.now().toString(36)}`;
  const root = mkdtempSync(join(tmpdir(), "pitwall-lock-check-"));
  writeFileSync(
    join(root, ".autofix.json"),
    `${JSON.stringify({ root, idPrefix: "fixture", lockPrefix: prefix, repos: {} })}\n`,
  );
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const lock = `/tmp/${prefix}-merge.lock`;
  mkdirSync(lock, { recursive: true });
  return { root, home, lock };
}

function drop(space: Workspace): void {
  rmSync(space.lock, { recursive: true, force: true });
}

function holder(space: Workspace, token: string, minutesAgo: number): void {
  const path = join(space.lock, "holder");
  writeFileSync(path, token);
  const when = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, when, when);
}

function claimingJournal(space: Workspace, run: string, token: string, minutesAgo: number): void {
  const dir = join(space.home, ".claude", "projects", "slug", "session", "subagents", "workflows", run);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "result", token, status: "taken" })}\n`);
  const when = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, when, when);
}

function check(space: Workspace): { status: number; out: string; err: string } {
  const ran = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd: space.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: gnuStatOnPath(),
      HOME: space.home,
      DEVLOOP_ROOT: space.root,
      PITWALL_CONFIG: undefined,
      DEVLOOP_CONFIG: undefined,
    },
  });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

test("a holder whose run is still writing is ALIVE under GNU stat, where -f is not a format flag", () => {
  const space = workspace();
  try {
    holder(space, "tok-alive", 45);
    claimingJournal(space, "wf-alive", "tok-alive", 2);

    const { status, out, err } = check(space);

    assert.equal(status, 0, `${out}${err}`);
    assert.equal(err, "");
    assert.match(out, /merge lock held 45m by tok-alive - its run wrote 2m ago, ALIVE/);
  } finally {
    drop(space);
  }
});

test("a holder whose run stopped writing is called dead with both ages as numbers under GNU stat", () => {
  const space = workspace();
  try {
    holder(space, "tok-dead", 45);
    claimingJournal(space, "wf-dead", "tok-dead", 30);

    const { status, out, err } = check(space);

    assert.equal(status, 1, `${out}${err}`);
    assert.equal(err, "");
    assert.match(out, /MERGE LOCK LOOKS DEAD: held 45m by tok-dead, its run has not written for 30m\./);
  } finally {
    drop(space);
  }
});

test("an empty holder file still reports how long it has been held under GNU stat", () => {
  const space = workspace();
  try {
    holder(space, "", 7);

    const { status, out, err } = check(space);

    assert.equal(status, 1, `${out}${err}`);
    assert.equal(err, "");
    assert.match(out, /MERGE LOCK held 7m with an EMPTY holder file/);
  } finally {
    drop(space);
  }
});
