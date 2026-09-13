import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const QUEUE_SH = join(SKILL, "queue.sh");
const CONFIG_SH = join(SKILL, "config.sh");

const LANDER_ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "lander-1788964650-29574",
  repos: { site: { path: "cli", slug: "404sl/pitwall" } },
};

const PR = {
  slug: "404sl/pitwall",
  number: 186,
  title: "Read the live view from one place",
  branch: "devloop/pitwall-7bn",
  issue: "pitwall-7bn",
};

const DECLARED = {
  fetched: true,
  status: "read",
  prStatus: "read",
  masterVersion: "0.1.33",
  branchVersion: "0.1.34",
  touchesPlugin: true,
  labelled: true,
  open: true,
  notes: "",
};

function lander(why: string, pr: Record<string, unknown> = PR) {
  return runScript("land.js", LANDER_ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: [pr] } : { prs: [] };
    if (call.label.startsWith("version:")) return DECLARED;
    if (call.label.startsWith("land:")) return { status: why, failureDetail: "five tests master added failed against the rebased head" };
    if (call.label.startsWith("retire:")) return { status: "retired", retired: [String(pr["issue"] || "")] };
    return { status: "released" };
  });
}

const ROUTE = `bd update pitwall-7bn --metadata '{"rework":{"pr":186,"repo":"site","why":`;

for (const why of ["red_after_rebase", "conflict"] as const) {
  test(`a ${why} retirement writes the pull request onto the issue as rework metadata before it reopens it`, async () => {
    const { calls, done } = lander(why);
    await done;

    const retire = calls.find((c) => c.label.startsWith("retire:"));
    assert.ok(retire, `nothing was retired: ${calls.map((c) => c.label).join(", ")}`);
    const route = `${ROUTE}"${why}"}}'`;
    assert.ok(
      retire.prompt.includes(route),
      `the retire step is not told to record where the issue goes next, so the only record of the pull request ` +
        `number is prose in a note that a person has to read:\n${retire.prompt}`,
    );
    const reopen = retire.prompt.indexOf("bd update pitwall-7bn --status open");
    assert.ok(reopen > 0, "the retire step no longer reopens the issue by its id");
    assert.ok(
      retire.prompt.indexOf(route) < reopen,
      "the route is written after the issue is reopened - a crash between the two hands queue.sh --next an issue with no route, which it offers to task.js",
    );
    assert.ok(
      reopen < retire.prompt.indexOf("--remove-label"),
      "the label comes off before the issue is reopened",
    );
    assert.equal(retire.prompt.includes("`"), false, "a backtick in the retire brief closes its template literal early");
  });
}

test("a retirement that names no tracker issue is told there is nowhere to record the route", async () => {
  const { calls, done } = lander("red_after_rebase", { ...PR, issue: undefined });
  await done;
  const retire = calls.find((c) => c.label.startsWith("retire:"));
  assert.ok(retire);
  assert.equal(retire.prompt.includes("--metadata '"), false, "a metadata write was rendered against an issue id that does not exist");
  assert.match(retire.prompt, /nowhere to record it/);
});

type Issue = { id: string; title: string; metadata?: Record<string, unknown> };

type Bd = { bin: string; log: string; cwd: string };

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
      assignee: "fixture-devloop",
      metadata: i.metadata ?? null,
      created_at: "2026-09-13T00:00:00Z",
      updated_at: "2026-09-13T00:00:00Z",
    })),
  );
  const bin = mkdtempSync(join(tmpdir(), "pitwall-retire-route-bin-"));
  const log = join(bin, "calls.log");
  const cwd = join(bin, "cwd.log");
  const stub = join(bin, "bd");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(log)}`,
      `pwd -P >> ${JSON.stringify(cwd)}`,
      'case "$*" in',
      "  *'--status open --json'*)",
      "    cat <<'JSON'",
      payload,
      "JSON",
      "    ;;",
      "  *'show '*'--json'*)",
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
  return { bin, log, cwd };
}

const REWORK: Issue = {
  id: "fixture-rework",
  title: "retired red after rebase",
  metadata: { origin: { session: "fixture-devloop", ref: "c469cd" }, rework: { pr: 186, repo: "site", why: "red_after_rebase" } },
};
const PLAIN: Issue = { id: "fixture-plain", title: "ordinary work", metadata: { origin: { session: "fixture-devloop", ref: "c469cd" } } };

let sequence = 0;

function workspace(lanes = 4): { root: string; prefix: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "pitwall-retire-route-"));
  const prefix = `pwretire${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  mkdirSync(join(root, ".beads"));
  writeFileSync(
    config,
    `${JSON.stringify({ root, idPrefix: "fixture", lockPrefix: prefix, lanes, actor: "fixture-devloop", repos: { site: { path: "repo", slug: "acme/site", test: "npm test" } } })}\n`,
  );
  return { root, prefix, config };
}

function clean(ws: { root: string; prefix: string }): void {
  rmSync(slotsPath(ws.prefix), { recursive: true, force: true });
  for (let lane = 1; lane <= 9; lane += 1) {
    rmSync(join(LOCK_ROOT, `${ws.prefix}-lane-${lane}.lock`), { recursive: true, force: true });
  }
  rmSync(ws.root, { recursive: true, force: true });
}

function run(script: string, ws: { root: string; config: string }, bd: Bd, args: readonly string[], cwd = ws.root): { status: number; out: string; err: string } {
  const ran = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: ws.root,
      PITWALL_CONFIG: ws.config,
      DEVLOOP_CONFIG: undefined,
      BEADS_ACTOR: undefined,
      BEADS_DIR: "",
      PATH: `${bd.bin}:${process.env["PATH"] ?? ""}`,
    },
  });
  return { status: ran.status ?? -1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
}

function calls(bd: Bd): readonly string[] {
  return existsSync(bd.log) ? readFileSync(bd.log, "utf8").trim().split("\n") : [];
}

function ranFrom(bd: Bd): readonly string[] {
  return existsSync(bd.cwd) ? readFileSync(bd.cwd, "utf8").trim().split("\n") : [];
}

test("queue.sh --next hands a retired issue out as a rework, with its pull request and repository, and never as a task", () => {
  const ws = workspace();
  const bd = stubBd([REWORK, PLAIN]);
  try {
    const { status, out, err } = run(QUEUE_SH, ws, bd, ["--next", "2"]);
    assert.equal(status, 0, `${out}${err}`);
    assert.match(
      out,
      /^fixture-rework \d+ rework 186 site$/m,
      `a retired issue was handed out as a plain task line, and task.js triage bounces a pull request that is done and green:\n${out}`,
    );
    assert.match(out, /^fixture-plain \d+$/m, `an ordinary issue no longer prints as <id> <slot>:\n${out}`);
    assert.doesNotMatch(out, /^fixture-rework \d+$/m);
    assert.ok(calls(bd).includes("--actor fixture-devloop update fixture-rework --claim"), "the rework was handed out without being claimed");
    const rework = out.split("\n").findIndex((l) => l.startsWith("fixture-rework "));
    const plain = out.split("\n").findIndex((l) => l.startsWith("fixture-plain "));
    assert.ok(rework < plain, "a retired branch drifts further from master every round it waits, so it goes before new work of the same priority");
  } finally {
    clean(ws);
  }
});

test("queue.sh marks a retired issue in NEXT UP so a reader can see it is a rework", () => {
  const ws = workspace();
  const bd = stubBd([REWORK, PLAIN]);
  try {
    const { status, out, err } = run(QUEUE_SH, ws, bd, []);
    assert.equal(status, 0, `${out}${err}`);
    assert.match(out, /fixture-rework .*rework #186 site/, out);
  } finally {
    clean(ws);
  }
});

test("config.sh --args refuses an issue carrying rework metadata and names the command that takes it", () => {
  const ws = workspace();
  const bd = stubBd([REWORK]);
  try {
    const ran = run(CONFIG_SH, ws, bd, ["--args", "fixture-rework"]);
    assert.notEqual(ran.status, 0, `task.js args were built for a retired pull request:\n${ran.out}`);
    assert.equal(ran.out, "");
    assert.match(ran.err, /config\.sh --rework fixture-rework 186 site/);
    assert.equal(existsSync(join(slotsPath(ws.prefix), "1")), false, "a lane was reserved for a dispatch that was refused");
  } finally {
    clean(ws);
  }
});

test("config.sh --args asks bd from the tracker root, so the refusal holds when the supervisor sits inside a repository", () => {
  const ws = workspace();
  const bd = stubBd([REWORK]);
  try {
    const repo = join(ws.root, "repo");
    mkdirSync(repo);
    const ran = run(CONFIG_SH, ws, bd, ["--args", "fixture-rework"], repo);
    assert.notEqual(ran.status, 0, `task.js args were built for a retired pull request from inside a repository:\n${ran.out}`);
    assert.match(ran.err, /config\.sh --rework fixture-rework 186 site/);
    const from = ranFrom(bd);
    assert.ok(from.length > 0, "bd was never asked");
    assert.deepEqual(
      [...new Set(from)],
      [realpathSync(ws.root)],
      `bd resolves its database from the working directory and answers "no beads database found" from inside a repository; it ran from ${from.join(", ")}`,
    );
  } finally {
    clean(ws);
  }
});

test("config.sh --args still builds task.js args for an issue with no rework metadata, and when bd cannot answer", () => {
  const ws = workspace();
  const bd = stubBd([PLAIN]);
  try {
    const ran = run(CONFIG_SH, ws, bd, ["--args", "fixture-plain"]);
    assert.equal(ran.status, 0, ran.err);
    assert.equal((JSON.parse(ran.out) as { id: string }).id, "fixture-plain");
    writeFileSync(join(bd.bin, "bd"), "#!/bin/sh\nexit 1\n");
    const again = run(CONFIG_SH, ws, bd, ["--args", "fixture-unknown"]);
    assert.equal(again.status, 0, again.err);
  } finally {
    clean(ws);
  }
});

const REWORK_ARGS = {
  id: "zz-aaa1",
  pr: 186,
  repo: "site",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { site: { slug: "acme/site", path: "repo", test: "npm test", lint: "npm run lint" } },
};

const RESOLVED = { status: "already_clean", branch: "devloop/zz-aaa1", oldHead: "bbbbbbb", newHead: "bbbbbbb", files: [] };
const RED = { status: "red", ciConclusion: "failure", failures: "test/live.test.ts: 5 failing", notes: "red" };
const REPAIRED = { status: "repaired", head: "ccccccc", files: ["src/live.ts"], notes: "followed master" };
const RELEASED = { lane: "released", slot: "released", notes: "lane: RELEASED" };

test("a rework that ends for a person clears the route and parks the issue, so a reopen does not run a second repair", async () => {
  const { calls: made, done } = runScript("rework.js", REWORK_ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return RED;
    if (n === 3) return REPAIRED;
    if (n === 4) return RED;
    return RELEASED;
  });
  const result = await done;
  assert.equal(result["outcome"], "red");

  const repair = made.find((c) => c.label === "repair:zz-aaa1#186");
  const second = made.filter((c) => c.label === "handoff:zz-aaa1#186")[1];
  assert.ok(repair && second);
  for (const [name, call] of [["repair", repair], ["second handoff", second]] as const) {
    assert.ok(call.prompt.includes("bd update zz-aaa1 --unset-metadata rework"), `the ${name} brief leaves the rework route on an issue whose rework has ended - a reopen sends it round again`);
    assert.ok(call.prompt.includes("--add-label needs-decision"), `the ${name} brief does not park the issue for a person`);
    assert.ok(call.prompt.includes("--status open"), `the ${name} brief leaves the issue in_progress behind a dead pull request`);
  }
});

const HAND_BACK = "cd /root && bd update zz-aaa1 --unset-metadata rework --add-label needs-decision --status open";

for (const [ending, repair] of [
  ["reports a fix whose head did not move", { ...REPAIRED, head: RESOLVED.newHead }],
  ["returns nothing", undefined],
] as const) {
  test(`a rework whose repair ${ending} ends red with the hand-back command in its notes, because no agent ran it`, async () => {
    const { calls: made, done } = runScript("rework.js", REWORK_ARGS, (_call, n) => {
      if (n === 1) return RESOLVED;
      if (n === 2) return RED;
      if (n === 3) return repair;
      return RELEASED;
    });
    const result = await done;
    assert.equal(result["outcome"], "red");
    assert.equal(result["repairs"], 1);
    assert.equal(made.filter((c) => c.label === "handoff:zz-aaa1#186").length, 1, "a second handoff ran against a head that was never pushed");
    assert.ok(
      String(result["notes"]).includes(HAND_BACK),
      `the run ended red with the rework route still on the issue and told nobody how to take it off - the next reopen runs a second repair:\n${String(result["notes"])}`,
    );
  });
}
