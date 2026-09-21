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

test("a rework whose merged head is red gets one repair step, briefed from the failures, then hands off again", async () => {
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
  assert.equal(/git push[^\n]*--force/.test(repair.prompt), false, "the repair step forces its push - one commit on top of the head the remote holds is a plain fast-forward, and a force-push is what the session refuses");
  assert.ok(repair.prompt.includes(`git push origin HEAD:refs/heads/devloop/${ID}`), "the repair step does not push a plain fast-forward with both ends named - a bare HEAD from a detached worktree is refused as an unqualified destination");
  assert.ok(repair.prompt.includes(`--pre-push --branch devloop/${ID} --base master`), "the repair step's pre-push check is not told the branch, and HEAD is detached, so the check cannot ask the remote what is published");
  assert.equal(repair.prompt.includes("--rebased"), false, "the repair step tells the pre-push check the range was rebased, and nothing was");
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

const ON_MASTER = { branch: `devloop/${ID}`, oldHead: "bbbbbbb", newHead: "bbbbbbb", files: [] };

for (const status of ["already_clean", "resolved"] as const) {
  test(`a branch the lander already rebased and pushed - resolve answers ${status} with an unmoved head - still reaches the repair step`, async () => {
    const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
      if (n === 1) return { status, ...ON_MASTER };
      if (n === 2) return RED;
      if (n === 3) return REPAIRED;
      if (n === 4) return GREEN;
      return RELEASED;
    });

    const result = await done;
    assert.deepEqual(
      calls.map((c) => c.label),
      [`resolve:${ID}#${PR}`, `handoff:${ID}#${PR}`, `repair:${ID}#${PR}`, `handoff:${ID}#${PR}`, `release:${ID}#${PR}`],
      "a rebase that replayed nothing onto a head already on master was read as a resolution that was never pushed",
    );

    const repair = labelled(calls, `repair:${ID}#${PR}`)[0]!;
    assert.ok(repair.prompt.includes("git log -p -5 origin/master"), "the repair step is not pointed at master's own history of the failing file");
    assert.equal(repair.prompt.includes("git diff bbbbbbb...origin/master"), false, "the repair step is handed a three-dot diff from master's own tip, which shows nothing");
    assert.ok(/already sat on top of master/.test(repair.prompt), "the repair step is not told why there is no diff to read");
    assert.equal(repair.prompt.includes("`"), false, "a backtick in the repair brief closes its template literal early");

    assert.equal(result["outcome"], "verified");
    assert.equal(result["repairs"], 1);
    assert.equal(result["oldHead"], "bbbbbbb");
    assert.equal(result["newHead"], "ccccccc", "the result does not name the repaired head that was actually labelled");
    assert.deepEqual(result["repaired"], ["src/live.ts"]);
    assert.equal(result["lane"], "released");
  });
}

test("a resolve that names resolved files but did not move the head is still not believed", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return { status: "resolved", ...ON_MASTER, files: ["db/schema.rb"] };
    return RELEASED;
  });

  const result = await done;
  assert.deepEqual(calls.map((c) => c.label), [`resolve:${ID}#${PR}`, `release:${ID}#${PR}`]);
  assert.equal(result["outcome"], "blocked");
  assert.match(String(result["notes"]), /1 file\(s\) resolved but the branch head did not move/);
});

test("the resolve step is told a retired branch already sits on master and answers already_clean", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return GREEN;
    return RELEASED;
  });
  await done;
  const resolve = labelled(calls, `resolve:${ID}#${PR}`)[0]!;
  assert.ok(/RED AFTER REBASE/.test(resolve.prompt), "the resolve brief names only the conflicting arrival");
  assert.ok(resolve.prompt.includes("merge-base --is-ancestor origin/master HEAD && echo ON_MASTER"), "the resolve step is not given a way to tell the two arrivals apart");
  assert.ok(/never call it\n?"resolved"/.test(resolve.prompt), "the resolve step is not warned off answering resolved for a rebase that replayed nothing");
  assert.equal(resolve.prompt.includes("`"), false, "a backtick in the resolve brief closes its template literal early");
});

test("a repair that goes through is not told to write a red-head note on the issue", async () => {
  const { calls, done } = runScript("rework.js", ARGS, (_call, n) => {
    if (n === 1) return RESOLVED;
    if (n === 2) return RED;
    if (n === 3) return REPAIRED;
    if (n === 4) return GREEN;
    return RELEASED;
  });
  await done;
  const repair = labelled(calls, `repair:${ID}#${PR}`)[0]!;
  assert.ok(repair.prompt.includes("ONLY WHEN YOU ARE BLOCKED: WRITE IT ON THE TRACKER ISSUE"), "the tracker note in the repair brief is not gated on being blocked");
  assert.ok(/handoff step that follows writes\nthe tracker note/.test(repair.prompt), "a successful repair is not told who writes its note");
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
