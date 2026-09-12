import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const RUN_SCRIPT = join(SKILL, "run-script.sh");
const CONFIG_SH = join(SKILL, "config.sh");
const STAGED = ["task.js", "land.js", "rework.js", "land-train.js"];

interface Harness {
  root: string;
  bin: string;
  config: string;
  prefix: string;
  slots: string;
  stage: string;
}

let sequence = 0;

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-run-script-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  const prefix = `pwrunscript${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  writeFileSync(
    config,
    JSON.stringify({
      root,
      idPrefix: "zz",
      lockPrefix: prefix,
      lanes: 2,
      repos: { site: { path: "repo", test: "npm test", slug: "404sl/pitwall" } },
    }),
  );
  const bd = join(bin, "bd");
  writeFileSync(bd, "#!/bin/sh\nexit 1\n");
  chmodSync(bd, 0o755);
  return { root, bin, config, prefix, slots: slotsPath(prefix), stage: join(root, ".autofix-run") };
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

function run(box: Harness, script: string, ...rest: string[]): Ran {
  const ran = spawnSync("bash", [script, ...rest], {
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

function stale(box: Harness, name: string): void {
  mkdirSync(box.stage, { recursive: true });
  writeFileSync(join(box.stage, name), "throw new Error('a release ago')\n");
}

function installed(name: string): string {
  return readFileSync(join(SKILL, name), "utf8");
}

function staged(box: Harness, name: string): string {
  return readFileSync(join(box.stage, name), "utf8");
}

test("staging replaces every workflow script with this install's copy", () => {
  const box = harness();
  try {
    for (const name of STAGED) stale(box, name);

    const ran = run(box, RUN_SCRIPT, "task.js");
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), join(box.stage, "task.js"));

    for (const name of STAGED) {
      assert.equal(staged(box, name), installed(name), `${name} was left at the stale copy`);
    }
  } finally {
    clean(box);
  }
});

test("staging leaves no half-written file behind", () => {
  const box = harness();
  try {
    assert.equal(run(box, RUN_SCRIPT).status, 0);
    assert.deepEqual(readdirSync(box.stage).sort(), [...STAGED].sort());
  } finally {
    clean(box);
  }
});

test("a name that is not a workflow script is refused", () => {
  const box = harness();
  try {
    const ran = run(box, RUN_SCRIPT, "queue.sh");
    assert.equal(ran.status, 2);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /is not a workflow script/);
  } finally {
    clean(box);
  }
});

test("a dispatch restages task.js and carries the path it staged", () => {
  const box = harness();
  try {
    stale(box, "task.js");

    const ran = run(box, CONFIG_SH, "--args", "zz-aaa1");
    assert.equal(ran.status, 0, ran.stderr);
    const args = JSON.parse(ran.stdout) as { scriptPath: string; slot: number };
    assert.equal(args.scriptPath, join(box.stage, "task.js"));
    assert.equal(args.slot, 1);
    assert.equal(staged(box, "task.js"), installed("task.js"));
  } finally {
    clean(box);
  }
});

test("a lander dispatch restages land.js and still names its pre-flighted PRs", () => {
  const box = harness();
  try {
    stale(box, "land.js");

    const ran = run(box, CONFIG_SH, "--land", "404sl/pitwall#588");
    assert.equal(ran.status, 0, ran.stderr);
    const args = JSON.parse(ran.stdout) as { scriptPath: string; preflighted: string[] };
    assert.equal(args.scriptPath, join(box.stage, "land.js"));
    assert.deepEqual(args.preflighted, ["404sl/pitwall#588"]);
    assert.equal(staged(box, "land.js"), installed("land.js"));
  } finally {
    clean(box);
  }
});

test("a lander dispatch mints a merge-lock token that is different every launch", () => {
  const box = harness();
  try {
    const first = run(box, CONFIG_SH, "--land");
    const second = run(box, CONFIG_SH, "--land");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const one = (JSON.parse(first.stdout) as { lockToken?: string }).lockToken;
    const two = (JSON.parse(second.stdout) as { lockToken?: string }).lockToken;

    for (const token of [one, two]) {
      assert.ok(
        token && /^lander-[A-Za-z0-9._-]+$/.test(token),
        `config.sh --land printed ${JSON.stringify(token)} as the merge-lock token. land.js ` +
          "refuses a launch whose token is absent or carries anything it cannot quote into a " +
          "single-quoted shell argument, so a token of the wrong shape is a lander that never " +
          "starts. The lander- prefix is what tells a holder file apart from a person merging " +
          "by hand.",
      );
    }
    assert.notEqual(
      one,
      two,
      "two launches were handed the same merge-lock token. The token is the only evidence a " +
        "run has that the lock step really ran for it rather than replaying an earlier answer, " +
        "and one shared by two launches proves nothing at all.",
    );
  } finally {
    clean(box);
  }
});

test("a train dispatch restages the train and names the repository it runs against", () => {
  const box = harness();
  try {
    stale(box, "land-train.js");

    const ran = run(box, CONFIG_SH, "--train", "site");
    assert.equal(ran.status, 0, ran.stderr);
    const args = JSON.parse(ran.stdout) as { scriptPath: string; repo: string };
    assert.equal(args.scriptPath, join(box.stage, "land-train.js"));
    assert.equal(
      args.repo,
      "site",
      "the dispatch carries no repo, and a train refuses to guess which repository it runs " +
        "against - so the launch the supervisor is told to build cannot start",
    );
    assert.equal(staged(box, "land-train.js"), installed("land-train.js"));
  } finally {
    clean(box);
  }
});

test("a train dispatch refuses a repository this workspace does not configure", () => {
  const box = harness();
  try {
    const ran = run(box, CONFIG_SH, "--train", "extension");
    assert.notEqual(ran.status, 0, `--train accepted a repository the config never names: ${ran.stdout}`);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /no repository extension in this config/);
  } finally {
    clean(box);
  }
});

test("a train dispatch mints a merge-lock token that is different every launch", () => {
  const box = harness();
  try {
    const first = run(box, CONFIG_SH, "--train", "site");
    const second = run(box, CONFIG_SH, "--train", "site");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const one = (JSON.parse(first.stdout) as { lockToken?: string }).lockToken;
    const two = (JSON.parse(second.stdout) as { lockToken?: string }).lockToken;

    for (const token of [one, two]) {
      assert.ok(
        token && /^land-train-[A-Za-z0-9._-]+$/.test(token),
        `config.sh --train printed ${JSON.stringify(token)} as the merge-lock token. ` +
          "land-train.js refuses a launch whose token is absent or carries anything it cannot " +
          "quote into a single-quoted shell argument, so a token of the wrong shape is a train " +
          "that never starts. The land-train- prefix is what tells a holder file apart from the " +
          "serial lander's and from a person merging by hand.",
      );
    }
    assert.notEqual(
      one,
      two,
      "two launches were handed the same merge-lock token. The token is the only evidence a " +
        "run has that the lock step really ran for it rather than replaying an earlier answer, " +
        "and one shared by two launches proves nothing at all.",
    );
  } finally {
    clean(box);
  }
});

test("nothing in the skill dispatches a scriptPath written out by hand", () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(SKILL)) {
    if (entry === "CHANGELOG.md") continue;
    const text = readFileSync(join(SKILL, entry), "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("scriptPath") && /\.js\b/.test(line)) offenders.push(`${entry}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a scriptPath naming a script spells out a path that is not the one just staged:\n${offenders.join("\n")}`,
  );
});
