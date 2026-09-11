import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "config.sh",
);

interface Harness {
  root: string;
  bin: string;
  config: string;
  prefix: string;
  slots: string;
}

const SESSION = "zz-devloop";

let sequence = 0;

function harness(lanes: number): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-dispatch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  const prefix = `pwdispatch${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  writeFileSync(
    config,
    JSON.stringify({
      root,
      idPrefix: "zz",
      lockPrefix: prefix,
      lanes,
      repos: { site: { path: "repo", test: "npm test" } },
    }),
  );
  const bd = join(bin, "bd");
  writeFileSync(
    bd,
    [
      "#!/bin/sh",
      'if [ "$1" = "show" ]; then',
      `  printf '{"id":"%s","labels":[],"assignee":"%s"}\\n' "$2" '${SESSION}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(bd, 0o755);
  return { root, bin, config, prefix, slots: slotsPath(prefix) };
}

function clean(box: Harness): void {
  rmSync(box.slots, { recursive: true, force: true });
  for (let lane = 1; lane <= 9; lane += 1) {
    rmSync(join(LOCK_ROOT, `${box.prefix}-lane-${lane}.lock`), { recursive: true, force: true });
  }
  rmSync(box.root, { recursive: true, force: true });
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function args(box: Harness, ...rest: string[]): Ran {
  const ran = spawnSync("bash", [SCRIPT, "--args", ...rest], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      PITWALL_SESSION: SESSION,
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function slotOf(ran: Ran): number {
  assert.equal(ran.status, 0, ran.stderr);
  return (JSON.parse(ran.stdout) as { slot: number }).slot;
}

function holder(box: Harness, slot: number): string {
  return readFileSync(join(box.slots, String(slot)), "utf8").trim();
}

test("a dispatch reserves the lane it reports", () => {
  const box = harness(2);
  try {
    const ran = args(box, "zz-aaa1");
    assert.equal(slotOf(ran), 1);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("dispatching the same issue twice hands back the one reservation", () => {
  const box = harness(2);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    assert.ok(!existsSync(join(box.slots, "2")));
  } finally {
    clean(box);
  }
});

test("a lane number that disagrees with the reservation is refused", () => {
  const box = harness(2);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    const ran = args(box, "zz-aaa1", "5");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /holds slot 1, not 5/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});

test("the lane number the reservation already names is accepted", () => {
  const box = harness(2);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    assert.equal(slotOf(args(box, "zz-aaa1", "1")), 1);
  } finally {
    clean(box);
  }
});

test("a locked lane is never handed to a dispatch", () => {
  const box = harness(2);
  try {
    mkdirSync(join(LOCK_ROOT, `${box.prefix}-lane-2.lock`), { recursive: true });
    assert.equal(slotOf(args(box, "zz-bbb1")), 2);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a full pool stops the dispatch instead of printing a guessed lane", () => {
  const box = harness(1);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    const ran = args(box, "zz-bbb1");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /dispatch stops/);
  } finally {
    clean(box);
  }
});
