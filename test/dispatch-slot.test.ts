import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";

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
  writeFileSync(bd, "#!/bin/sh\nexit 1\n");
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
  return dispatch(box, "--args", ...rest);
}

function rework(box: Harness, ...rest: string[]): Ran {
  return dispatch(box, "--rework", ...rest);
}

function dispatch(box: Harness, mode: string, ...rest: string[]): Ran {
  const ran = spawnSync("bash", [SCRIPT, mode, ...rest], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
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

interface Rework {
  id: string;
  pr: number;
  repo: string;
  slot: number;
  scriptPath: string;
  skillDir: string;
  root: string;
}

function reworkOf(ran: Ran): Rework {
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout) as Rework;
}

test("a rework dispatch reserves the lane it reports and carries the pull request", () => {
  const box = harness(2);
  try {
    const built = reworkOf(rework(box, "zz-aaa1", "739", "site"));
    assert.equal(built.slot, 1);
    assert.equal(holder(box, 1), "zz-aaa1");
    assert.equal(built.id, "zz-aaa1");
    assert.equal(built.pr, 739);
    assert.equal(built.repo, "site");
    assert.equal(built.root, box.root);
    assert.match(built.scriptPath, /\/rework\.js$/);
    assert.ok(existsSync(built.scriptPath), "the staged rework.js is not where scriptPath says");
    assert.ok(existsSync(join(built.skillDir, "release-lane.sh")));
  } finally {
    clean(box);
  }
});

test("reworking the same issue twice hands back the one reservation", () => {
  const box = harness(2);
  try {
    assert.equal(reworkOf(rework(box, "zz-aaa1", "739", "site")).slot, 1);
    assert.equal(reworkOf(rework(box, "zz-aaa1", "739", "site")).slot, 1);
    assert.ok(!existsSync(join(box.slots, "2")));
  } finally {
    clean(box);
  }
});

test("a rework dispatch takes no slot from the caller", () => {
  const box = harness(2);
  try {
    const ran = rework(box, "zz-aaa1", "739", "site", "2");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /usage: config.sh --rework/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a rework for a repository the config does not name reserves nothing", () => {
  const box = harness(2);
  try {
    const ran = rework(box, "zz-aaa1", "739", "extension");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /no repository extension/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a rework whose pull request is not a number reserves nothing", () => {
  const box = harness(2);
  try {
    const ran = rework(box, "zz-aaa1", "#739", "site");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /pull request must be a number/);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a locked lane is never handed to a rework", () => {
  const box = harness(2);
  try {
    mkdirSync(join(LOCK_ROOT, `${box.prefix}-lane-2.lock`), { recursive: true });
    assert.equal(reworkOf(rework(box, "zz-bbb1", "740", "site")).slot, 2);
    assert.ok(!existsSync(join(box.slots, "1")));
  } finally {
    clean(box);
  }
});

test("a full pool stops the rework instead of printing a guessed lane", () => {
  const box = harness(1);
  try {
    assert.equal(slotOf(args(box, "zz-aaa1")), 1);
    const ran = rework(box, "zz-bbb1", "740", "site");
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /dispatch stops/);
    assert.equal(holder(box, 1), "zz-aaa1");
  } finally {
    clean(box);
  }
});
