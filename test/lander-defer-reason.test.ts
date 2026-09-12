import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "lander-1788964650-29574",
  repos: { site: { path: "cli", slug: "404sl/pitwall" } },
};

const PR = {
  slug: "404sl/pitwall",
  number: 139,
  title: "Report an unreadable pull request as one the lander could not read",
  branch: "devloop/pitwall-znlr",
  issue: "pitwall-znlr",
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

const STALE_ROLLUP = "not_ready: rollup is empty on 139 - no check has registered, which is not a pass";

const BEYOND_ITS_VERSION =
  "usage: the devloop plugin version could not be assigned for devloop/pitwall-znlr - refused: " +
  "plugins/devloop/skills/devloop/CHANGELOG.md differs from origin/master in more than the version, and the " +
  "lander writes only the version into it - landing this would delete the rest of that change without saying so";

const MASTER_UNREADABLE =
  "usage: the devloop plugin version could not be assigned for devloop/pitwall-znlr - refused: " +
  "origin/master declares no version in plugins/devloop/.claude-plugin/plugin.json that reads as three numbers, " +
  "and a number nobody can read cannot be incremented";

const BODY_UNREADABLE =
  "usage: the devloop plugin version could not be assigned for devloop/pitwall-znlr - refused: " +
  "no changelog text could be read for pull request #139, and a version that moves with nothing under its " +
  "heading is the release note this exists to deliver";

type Result = {
  landed: { number?: number }[];
  stopped: { number?: number; why?: string; detail?: string }[];
  skipped: { number?: number; why?: string }[];
};

function lander(notes: string) {
  return runScript("land.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label.startsWith("survey")) return { prs: [PR] };
    if (call.label.startsWith("version:")) return DECLARED;
    if (call.label.startsWith("land:")) return { status: "blocked", notes };
    return { status: "released" };
  }) as { calls: Call[]; logs: string[]; done: Promise<Result> };
}

function attempts(calls: Call[]): number {
  return calls.filter((c) => c.label.startsWith("land:")).length;
}

function line(logs: string[], start: string): string {
  return logs.find((l) => l.startsWith(start)) || "";
}

test("a deferred pull request's log line carries what land-one.sh printed, not a sentence about CI", async () => {
  const { calls, logs, done } = lander(STALE_ROLLUP);
  const out = await done;

  const deferred = line(logs, "DEFERRED");
  assert.ok(
    deferred.includes("rollup is empty on 139"),
    "the DEFERRED line names a cause of its own instead of the one the script gave. Exit 6 and exit 7 " +
      "both arrive as 'blocked', so a fixed sentence about CI describes a version refusal as a stopwatch " +
      `and the run log names the wrong cause every round: ${logs.join("\n")}`,
  );
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 0);
  assert.ok(
    line(logs, "NOT ACTED ON").includes("rollup is empty on 139"),
    `the last word on a pull request no round landed still invents a cause: ${logs.join("\n")}`,
  );
});

test("an empty rollup is still deferred and still tried again in a later round", async () => {
  const { calls, logs, done } = lander(STALE_ROLLUP);
  const out = await done;

  assert.equal(
    attempts(calls),
    4,
    "an empty rollup was retired instead of being put back. That is the normal case documented at " +
      `land-one.sh's exit 7 and a later round is what clears it: ${logs.join("\n")}`,
  );
  assert.deepEqual(out.stopped, []);
  assert.equal(out.skipped.length, 1, JSON.stringify(out.skipped));
});

for (const [what, notes] of [
  ["a branch that changes a version file beyond its version", BEYOND_ITS_VERSION],
  ["a master version nothing can read", MASTER_UNREADABLE],
] as const) {
  test(`${what} is reported stopped, in the script's own words, rather than deferred forever`, async () => {
    const { calls, logs, done } = lander(notes);
    const out = await done;

    assert.equal(
      attempts(calls),
      1,
      "a refusal no later round can clear was deferred and attempted again. Nothing about waiting " +
        `changes what the script read, so every round refuses it identically: ${logs.join("\n")}`,
    );
    assert.equal(out.stopped.length, 1, JSON.stringify(out.stopped));
    assert.equal(out.stopped[0]?.why, "version_refused");
    assert.ok(
      (out.stopped[0]?.detail || "").includes(notes),
      `the refusal reached the run without the words the script used: ${out.stopped[0]?.detail}`,
    );
    assert.ok(line(logs, "STOPPED").includes(notes), `the STOPPED line does not quote the refusal: ${logs.join("\n")}`);
    assert.equal(line(logs, "DEFERRED"), "", `a refusal was logged as deferred as well as stopped: ${logs.join("\n")}`);
    assert.equal(
      calls.filter((c) => c.label.startsWith("retire:")).length,
      0,
      "a refused version pulled the label off the pull request. A refusal is not a finding against the " +
        `change and the author's work stays queued for the next run: ${logs.join("\n")}`,
    );
  });
}

test("a refusal that only says a pull request body could not be read is still deferred", async () => {
  const { calls, logs, done } = lander(BODY_UNREADABLE);
  const out = await done;

  assert.deepEqual(
    out.stopped,
    [],
    "a read that failed was treated as a refusal that can never clear. gh answering again is exactly " +
      `what a later round changes: ${logs.join("\n")}`,
  );
  assert.equal(attempts(calls), 4, logs.join("\n"));
  assert.ok(line(logs, "DEFERRED").includes("no changelog text could be read"), logs.join("\n"));
});
