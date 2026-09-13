import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ID = "zz-aaa1";
const PR = 739;

const ARGS = {
  id: ID,
  pr: PR,
  repo: "site",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { site: { slug: "acme/site", path: "repo", test: "npm test", lint: "npm run lint" } },
};

const RESOLVED = { status: "resolved", branch: `devloop/${ID}`, oldHead: "aaaaaaa", newHead: "bbbbbbb", files: [] };
const FAILURES = "src/live.ts(12,10): error TS2459: Module './autofix.js' declares 'collectionError' locally, but it is not exported.";
const RED = { status: "red", ciConclusion: "failure", failures: FAILURES, notes: "one compiler error" };
const REPAIRED = { status: "repaired", head: "ccccccc", files: ["src/live.ts"], notes: "master moved collectionError to errors.ts; the import follows it" };
const GREEN = { status: "verified", ciConclusion: "success", notes: "labelled" };
const RELEASED = { lane: "released", slot: "released", notes: "lane: RELEASED" };

function labelled(calls: Call[], label: string): Call[] {
  return calls.filter((c) => c.label === label);
}

test("a rework whose rebased head is red gets one repair step, briefed from the failures, then hands off again", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return RED;
    if (n === 3) return REPAIRED;
    if (n === 4) return GREEN;
    return RELEASED;
  });

  const result = await done;
  assert.deepEqual(
    calls.map((c) => c.label),
    [`resolve:${ID}#${PR}`, `handoff:${ID}#${PR}`, `repair:${ID}#${PR}`, `handoff:${ID}#${PR}`, `release:${ID}#${PR}`],
    "a red handoff is not followed by exactly one repair and one more handoff",
  );

  const repair = labelled(calls, `repair:${ID}#${PR}`)[0]!;
  assert.ok(repair.prompt.includes(FAILURES), "the repair step is not handed the failures CI reported, verbatim");
  assert.ok(repair.prompt.includes("/tmp/pw-worktrees/zz-aaa1-rework"), "the repair step is not told which worktree holds the branch");
  assert.ok(repair.prompt.includes("tests:  npm test"), "the repair step is not told how this repository runs its tests");
  assert.ok(repair.prompt.includes("lint:   npm run lint"), "the repair step is not told how this repository lints");
  assert.ok(repair.prompt.includes("git diff aaaaaaa...origin/master"), "the repair step is not pointed at what master changed since the branch forked");
  assert.ok(repair.prompt.includes("--force-with-lease="), "the repair step pushes without a lease");
  assert.equal(/\bgit push --force\b(?!-with-lease)/.test(repair.prompt), false, "the repair step is offered a plain force push");
  assert.ok(/DO NOT REDESIGN, REBUILD OR "IMPROVE"/.test(repair.prompt), "the repair step is not told to leave the feature alone");
  assert.ok(repair.prompt.includes("ONE attempt"), "the repair step is not told it gets one attempt");
  assert.equal(repair.prompt.includes("`"), false, "a backtick in the repair brief closes its template literal early");
  assert.deepEqual(repair.schema.properties.status.enum, ["repaired", "blocked"]);

  const again = labelled(calls, `handoff:${ID}#${PR}`)[1]!;
  assert.ok(again.prompt.includes("ccccccc"), "the second handoff is not told which head to wait for");
  assert.ok(again.prompt.includes("lane-handoff.sh"), "the second handoff does not hand off through the script");
  assert.ok(again.prompt.includes("bd-note.sh zz-aaa1"), "a second red is not written onto the tracker issue for the person who takes it");
  assert.equal(again.prompt.includes("`"), false, "a backtick in the handoff brief closes its template literal early");

  assert.equal(result["outcome"], "verified");
  assert.equal(result["repairs"], 1);
  assert.equal(result["newHead"], "ccccccc", "the result does not name the head that was actually labelled");
  assert.deepEqual(result["repaired"], ["src/live.ts"]);
  assert.equal(result["lane"], "released");
  assert.equal(result["slot"], "released");
});

test("a repair is attempted exactly once - red again ends the run for a person", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return RED;
    if (n === 3) return REPAIRED;
    if (n === 4) return { status: "red", ciConclusion: "failure", failures: "test/live.test.ts: 2 failing", notes: "still red" };
    return RELEASED;
  });

  const result = await done;
  assert.equal(labelled(calls, `repair:${ID}#${PR}`).length, 1, "a second red head was sent for a second repair");
  assert.equal(labelled(calls, `handoff:${ID}#${PR}`).length, 2);
  assert.equal(labelled(calls, `release:${ID}#${PR}`).length, 1);
  assert.equal(result["outcome"], "red");
  assert.equal(result["repairs"], 1);
  assert.equal(result["ci"], "failure");
  assert.equal(result["notes"], "still red");
});

test("a repair that cannot mend the break ends red without waiting on CI again", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return RED;
    if (n === 3) return { status: "blocked", notes: "master's test asserts the opposite of what the branch exists to do" };
    return RELEASED;
  });

  const result = await done;
  assert.equal(labelled(calls, `handoff:${ID}#${PR}`).length, 1, "a blocked repair was handed off anyway");
  assert.equal(result["outcome"], "red");
  assert.equal(result["repairs"], 1);
  assert.deepEqual(result["repaired"], []);
  assert.equal(result["newHead"], "bbbbbbb");
  assert.match(String(result["notes"]), /one compiler error/);
  assert.match(String(result["notes"]), /asserts the opposite/);
  assert.equal(result["lane"], "released");
});

test("a repair that reports success without moving the head is not believed", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return RED;
    if (n === 3) return { ...REPAIRED, head: "bbbbbbb" };
    return RELEASED;
  });

  const result = await done;
  assert.equal(labelled(calls, `handoff:${ID}#${PR}`).length, 1, "a repair that pushed nothing was waited on as if it had");
  assert.equal(result["outcome"], "red");
  assert.match(String(result["notes"]), /head did not move/);
});

test("a green rebased head never sees the repair step", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return GREEN;
    return RELEASED;
  });

  const result = await done;
  assert.equal(labelled(calls, `repair:${ID}#${PR}`).length, 0);
  assert.equal(result["outcome"], "verified");
  assert.equal(result["repairs"], 0);
  assert.equal(result["newHead"], "bbbbbbb");
});

test("the first handoff is told to report the failures rather than fix them", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return GREEN;
    return RELEASED;
  });
  await done;
  const handoff = labelled(calls, `handoff:${ID}#${PR}`)[0]!;
  assert.ok(/DO NOT FIX THEM HERE/.test(handoff.prompt), "the handoff step is still invited to repair a red head itself");
  assert.ok(handoff.prompt.includes("--log-failed"), "the handoff step is not told where the failures are read from");
  assert.ok(handoff.schema.properties.failures, "the handoff schema has no field to carry the failures to the repair step");
  assert.equal(handoff.prompt.includes("`"), false, "a backtick in the handoff brief closes its template literal early");
});
