import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  repos: { site: { path: "cli", slug: "404sl/pitwall" } },
};

const TRAIN_ARGS = { ...ARGS, repo: "site" };

const PR = {
  slug: "404sl/pitwall",
  number: 80,
  title: "Verify the lane rescue diff before removing the worktree",
  branch: "devloop/pitwall-maz",
  issue: "pitwall-maz",
};

const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";

type Declared = {
  fetched?: boolean;
  status: string;
  prStatus?: string;
  masterVersion: string;
  branchVersion: string;
  touchesPlugin: boolean;
  labelled?: boolean;
  open?: boolean;
  notes: string;
};

function declared(over: Partial<Declared> = {}): Declared {
  return {
    fetched: true,
    status: "read",
    prStatus: "read",
    masterVersion: "0.1.21",
    branchVersion: "0.1.22",
    touchesPlugin: true,
    labelled: true,
    open: true,
    notes: "",
    ...over,
  };
}

type Result = {
  landed: { number?: number }[];
  stopped: { number?: number; why?: string; detail?: string }[];
  skipped: { number?: number; why?: string }[];
};

function lander(reply: Declared | null, land: unknown = { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" }) {
  return runScript("land.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: [PR] } : { prs: [] };
    if (call.label.startsWith("version:")) return reply;
    if (call.label.startsWith("land:")) return land;
    return { status: "released" };
  }) as { calls: Call[]; logs: string[]; done: Promise<Result> };
}

function train(reply: Declared | null) {
  return runScript("land-train.js", TRAIN_ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "train-1788964650-29574", holder: "train-1788964650-29574" };
    if (call.label.startsWith("build:")) return { status: "built", trainPr: 120, trainBranch: "release/train-1", included: [80], skipped: [] };
    if (call.label.startsWith("verify:")) return { status: "green", failingSpecs: [] };
    if (call.label.startsWith("version:")) return reply;
    if (call.label.startsWith("merge:")) return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    return { status: "released" };
  });
}

function labels(calls: Call[]) {
  return calls.map((c) => c.label).join(", ");
}

test("land.js lands a plugin branch declaring the version master already holds, because the lander assigns the number", async () => {
  const { calls, logs, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.21" }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    "a branch declaring the number master holds was refused. Every lane in a pass reads the same " +
      "master and bumps to the same number, so refusing equality lands one pull request per pass and " +
      `retires the rest - measured on 2026-09-12, four of five. Steps: ${labels(calls)}`,
  );
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 1);
  assert.ok(
    logs.some((l) => l.includes("0.1.21") && /assigns the one after/.test(l)),
    `the run log does not say where the number that lands comes from: ${logs.join("\n")}`,
  );
});

test("land.js lands a plugin branch whose declared version is behind master, because that number is not used", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.17" }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    "a branch whose own number is behind was refused, and nothing in the pipeline would ever have " +
      `raised it - the lander writes the three version files from master itself: ${labels(calls)}`,
  );
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 1);
  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    `finished, green work was un-queued over a number it no longer chooses: ${labels(calls)}`,
  );
});

test("land.js lands a branch whose plugin version is strictly greater", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.22" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 1, `the merge step did not run: ${labels(calls)}`);
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 1);
});

test("land.js lands a branch that changes nothing the plugin ships, whatever the version says", async () => {
  const { calls, logs, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.21", touchesPlugin: false }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    `a branch touching no plugin file was refused, which would block every change to src/ and test/. Steps: ${labels(calls)}`,
  );
  assert.equal(out.landed.length, 1);
  assert.ok(
    logs.some((l) => l.includes("0.1.21") && /plugins\/ or \.claude-plugin\//.test(l)),
    `a wrong touchesPlugin skips this comparison silently, and the skip left nothing in the run log to notice it by: ${logs.join("\n")}`,
  );
});

test("land.js refuses rather than merges when master's version cannot be read", async () => {
  const { calls, done } = lander(declared({ status: "unreadable", masterVersion: "", branchVersion: "0.1.22", notes: "git fetch origin exited 128" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `an unreadable master let the merge through: ${labels(calls)}`);
  assert.equal(out.stopped[0]?.why, "version_unreadable");
  assert.match(out.stopped[0]?.detail || "", /git fetch origin exited 128/);
});

test("land.js lands a branch whose own version is not three numbers, since the branch's number is not read", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "v0.1.22-rc" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 1, labels(calls));
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 1);
});

test("land.js refuses when MASTER's version is not three numbers, because the number that lands is counted from it", async () => {
  const { calls, done } = lander(declared({ masterVersion: "v0.1.21-rc", branchVersion: "0.1.22" }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    0,
    `a master nobody can read let the merge through, and the version it would land cannot be computed: ${labels(calls)}`,
  );
  assert.equal(out.stopped[0]?.why, "version_unreadable");
  assert.match(out.stopped[0]?.detail || "", /v0\.1\.21-rc/);
  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    `a pull request was un-queued because master's own manifest is wrong: ${labels(calls)}`,
  );
});

test("land.js refuses rather than merges when the version step answers nothing", async () => {
  const { calls, done } = lander(null);
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `a silent version step let the merge through: ${labels(calls)}`);
  assert.equal(out.stopped[0]?.why, "version_unreadable");
});

test("land.js lands in a repository that ships no plugin manifest on master", async () => {
  const { calls, done } = lander(declared({ status: "no_manifest", masterVersion: "", branchVersion: "", touchesPlugin: true }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    `a repository with no plugin manifest was refused: ${labels(calls)}`,
  );
  assert.equal(out.landed.length, 1);
});

test("land.js reads master's version once per pull request, and both plugin branches of a pass land", async () => {
  const SECOND = { ...PR, number: 81, branch: "devloop/pitwall-maz2", issue: "pitwall-maz2" };
  const versions: Record<string, Declared> = {
    "404sl/pitwall#80": declared({ masterVersion: "0.1.21", branchVersion: "0.1.22" }),
    "404sl/pitwall#81": declared({ masterVersion: "0.1.22", branchVersion: "0.1.22" }),
  };
  const { calls, done } = runScript("land.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: [PR, SECOND] } : { prs: [] };
    if (call.label.startsWith("version:")) return versions[call.label.slice(8)];
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    return { status: "released" };
  }) as { calls: Call[]; logs: string[]; done: Promise<Result> };
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("version:")).length, 2, `master was not re-read per pull request: ${labels(calls)}`);
  assert.deepEqual(
    out.landed.map((l) => l.number),
    [80, 81],
    "the second plugin pull request of the pass did not land. It read the master the first one had " +
      "already moved, so its own number was equal rather than greater - which is the deadlock this " +
      `removes by not reading the branch's number at all: ${JSON.stringify(out.stopped)}`,
  );
  assert.deepEqual(out.stopped, []);
});

test("the land.js version step fetches origin before reading master", async () => {
  const { calls, done } = lander(declared());
  await done;

  const step = calls.find((c) => c.label.startsWith("version:"));
  assert.ok(step, `no version step ran: ${labels(calls)}`);
  assert.match(step.prompt, /git fetch origin --quiet/);
  assert.match(step.prompt, /git show origin\/master:plugins\/devloop\/\.claude-plugin\/plugin\.json/);
  assert.ok(
    step.prompt.indexOf("git fetch origin --quiet") < step.prompt.indexOf("git show origin/master:"),
    "the prompt reads master's manifest before fetching, so the number can be one the branch was pushed against",
  );
});

test("land-train.js refuses to merge a train whose plugin version is not ahead of master", async () => {
  const { calls, done } = train(declared({ masterVersion: "0.1.21", branchVersion: "0.1.21" }));
  const out = (await done) as { landed: number[]; stopped: string | null; notes: string | null };

  assert.equal(calls.filter((c) => c.label.startsWith("merge:")).length, 0, `the train merged anyway: ${labels(calls)}`);
  assert.deepEqual(out.landed, []);
  assert.equal(out.stopped, "version_not_ahead");
  assert.match(out.notes || "", /0\.1\.21/);
  assert.ok(
    calls.some((c) => c.label.startsWith("retire:")),
    `the refused train was left on the remote: ${labels(calls)}`,
  );
});

test("land-train.js refuses to merge a train when master's version cannot be read", async () => {
  const { calls, done } = train(declared({ status: "unreadable", masterVersion: "", notes: "plugin.json held no version field" }));
  const out = (await done) as { stopped: string | null; notes: string | null };

  assert.equal(calls.filter((c) => c.label.startsWith("merge:")).length, 0, `an unreadable master let the train merge: ${labels(calls)}`);
  assert.equal(out.stopped, "version_unreadable");
  assert.match(out.notes || "", /plugin\.json held no version field/);
});

test("land-train.js merges a train whose plugin version is strictly greater", async () => {
  const { calls, done } = train(declared({ masterVersion: "0.1.21", branchVersion: "0.1.22" }));
  const out = (await done) as { landed: number[]; stopped: string | null };

  assert.equal(calls.filter((c) => c.label.startsWith("merge:")).length, 1, `the train did not merge: ${labels(calls)}`);
  assert.deepEqual(out.landed, [80]);
  assert.equal(out.stopped, null);
});

test("land-train.js reads master's version after the train is green and before it merges", async () => {
  const { calls, done } = train(declared());
  await done;

  const order = calls.map((c) => c.label);
  const verify = order.findIndex((l) => l.startsWith("verify:"));
  const version = order.findIndex((l) => l.startsWith("version:"));
  const merge = order.findIndex((l) => l.startsWith("merge:"));
  assert.ok(verify >= 0 && version >= 0 && merge >= 0, `a step is missing: ${order.join(", ")}`);
  assert.ok(verify < version && version < merge, `the version is not read between the checks and the merge: ${order.join(", ")}`);
});

test("land.js un-queues nothing over a version, since no version refusal is left to act on", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.17" }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    "a pull request was retired over the number it declares. Four pull requests of finished, " +
      "reviewed, green work were retired that way on 2026-09-12, each costing a full re-dispatch " +
      `to recover: ${labels(calls)}`,
  );
  assert.equal(out.landed.length, 1);
});

test("land.js leaves a pull request queued when the version could not be read at all", async () => {
  const { calls, done } = lander(declared({ status: "unreadable", masterVersion: "", notes: "git fetch origin exited 128" }));
  await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    `a pull request was un-queued because a step could not read a number, which loses work on ignorance. Steps: ${labels(calls)}`,
  );
});

test("the version step is told to decide 'no manifest' from a probe, not from a command that errored", async () => {
  for (const { file, label } of [
    { file: "land.js", label: "version:" },
    { file: "land-train.js", label: "version:#" },
  ]) {
    const { calls, done } =
      file === "land.js" ? lander(declared()) : train(declared());
    await done;
    const step = calls.find((c) => c.label.startsWith(label));
    assert.ok(step, `${file} ran no version step`);
    assert.match(
      step.prompt,
      /git ls-tree --name-only origin\/master plugins\/devloop\/\.claude-plugin\/plugin\.json/,
      `${file} leaves 'this repository ships no plugin' to be inferred from git show failing, which a ` +
        `cautious reader reports as unreadable instead - and an unreadable verdict is never un-queued, ` +
        `so every repository without the plugin would be refused on every run forever`,
    );
    assert.match(step.prompt, /ls-tree printed NOTHING/);
  }
});

test("land.js does not un-queue a pull request whose label was pulled back while it waited for its turn", async () => {
  const { calls, done } = lander(
    declared({ masterVersion: "0.1.21", branchVersion: "0.1.17", labelled: false }),
    { status: "blocked", notes: "land-one.sh exit 7 - 404sl/pitwall#80 no longer carries lane-verified" },
  );
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    `a pull request a lane had pulled back for rework was un-queued, which appends a finding to an ` +
      `issue that lane holds in_progress and reopens it for a second lane. Steps: ${labels(calls)}`,
  );
  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    "nothing was delegated, so nothing re-read the label: the version step is one haiku read and " +
      `land-one.sh asks GitHub itself and exits 7 without merging: ${labels(calls)}`,
  );
  assert.deepEqual(out.landed, [], JSON.stringify(out.landed));
  assert.ok(
    out.skipped.some((s) => s.number === 80 && /still labelled/.test(s.why || "")),
    `it was neither deferred nor left alone: ${JSON.stringify({ stopped: out.stopped, skipped: out.skipped })}`,
  );
});

test("land.js does not un-queue a closed or draft pull request on its version either", async () => {
  const { calls, done } = lander(
    declared({ masterVersion: "0.1.21", branchVersion: "0.1.17", open: false }),
    { status: "blocked", notes: "land-one.sh exit 7" },
  );
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("retire:")).length, 0, `a closed pull request was un-queued: ${labels(calls)}`);
  assert.deepEqual(out.landed, [], JSON.stringify(out.landed));
});

test("the land.js version step reads the label and the state of the pull request it is about to merge", async () => {
  const { calls, done } = lander(declared());
  await done;

  const step = calls.find((c) => c.label.startsWith("version:"));
  assert.ok(step, `no version step ran: ${labels(calls)}`);
  assert.match(step.prompt, /gh pr view 80 --repo 404sl\/pitwall --json labels,state,isDraft/);
  assert.deepEqual(
    (step.schema?.required || []).filter((f: string) => f === "labelled" || f === "open"),
    ["labelled", "open"],
    "the queue state is optional in the schema, so a step that skips it takes a refusal with it",
  );
});

test("land-train.js logs the versions it did not compare when the train ships no plugin file", async () => {
  const { calls, logs, done } = train(declared({ masterVersion: "0.1.21", branchVersion: "0.1.21", touchesPlugin: false }));
  await done;

  assert.equal(calls.filter((c) => c.label.startsWith("merge:")).length, 1, `a train touching no plugin file was refused: ${labels(calls)}`);
  assert.ok(
    logs.some((l) => l.includes("0.1.21") && /plugins\/ or \.claude-plugin\//.test(l)),
    `the skip left nothing in the run log: ${logs.join("\n")}`,
  );
});

test("land.js refuses an unreadable master even when the step also reports the label gone", async () => {
  const { calls, done } = lander(
    declared({ status: "unreadable", masterVersion: "", labelled: false, open: false, notes: "git fetch origin exited 128" }),
    { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" },
  );
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    0,
    `a step that could read neither the manifest nor the pull request let the merge through, and ` +
      `land-one.sh checks the label and the checks but never a version: ${labels(calls)}`,
  );
  assert.equal(calls.filter((c) => c.label.startsWith("retire:")).length, 0, `it was un-queued on ignorance: ${labels(calls)}`);
  assert.equal(out.stopped[0]?.why, "version_unreadable");
  assert.match(out.stopped[0]?.detail || "", /git fetch origin exited 128/);
});

test("land.js lands a branch touching no plugin file when the manifest could not be read, because the guard does not govern it", async () => {
  const { calls, logs, done } = lander(
    declared({ status: "unreadable", masterVersion: "", branchVersion: "", touchesPlugin: false, notes: "git show origin/master exited 128" }),
  );
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    `a branch changing nothing under plugins/ or .claude-plugin/ was refused over a number the ` +
      `guard never compares for it: ${labels(calls)}`,
  );
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 1);
  assert.ok(
    logs.some((l) => /plugins\/ or \.claude-plugin\//.test(l)),
    `the versions were left uncompared and the run log says nothing about it, so a wrong ` +
      `touchesPlugin on an unreadable manifest passes silently: ${logs.join("\n")}`,
  );
});

test("land.js calls an unreadable pull request pr_unreadable, and does not spend a merge agent on it", async () => {
  const { calls, logs, done } = lander(
    declared({
      prStatus: "unreadable",
      labelled: false,
      open: false,
      notes: "gh pr view 37 failed with exit code 1: GraphQL API rate limit already exceeded",
    }),
  );
  const out = await done;

  assert.equal(out.stopped[0]?.why, "pr_unreadable");
  assert.match(out.stopped[0]?.detail || "", /rate limit already exceeded/);
  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    0,
    `a merge agent was spawned while gh could not answer, and land-one.sh reads an unanswerable ` +
      `rollup as red and exits 4 - which retires the pull request: ${labels(calls)}`,
  );
  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    `it was un-queued because gh was rate limited: ${labels(calls)}`,
  );
  assert.ok(
    !logs.some((l) => /is gone|closed, merged or draft/.test(l)),
    `labelled and open were read as facts from a gh call that printed nothing: ${logs.join("\n")}`,
  );
});

test("land.js keeps a rate-limited read off the version verdict even when the branch ships a plugin file", async () => {
  const { done } = lander(declared({ prStatus: "unreadable", touchesPlugin: true, labelled: false, open: false, notes: "API rate limit exceeded" }));
  const out = await done;

  assert.equal(
    out.stopped[0]?.why,
    "pr_unreadable",
    `a failed pull request read was reported as a version problem, which sends a reader to ` +
      `manifests and version arithmetic that were never wrong`,
  );
});

test("the version prompt asks for the manifest read and the pull request read as separate fields", async () => {
  const { calls, done } = lander(declared());
  await done;

  const prompt = calls.find((c) => c.label.startsWith("version:"))?.prompt || "";
  assert.match(prompt, /prStatus/, "the step has no field to report a failed gh call in");
  assert.ok(
    !/gh pr view printed no answer\. Say which in notes/.test(prompt),
    "the prompt still routes a failed gh call into status, which is the field the version verdict reads",
  );
});

test("land.js refuses a branch the version guard does not govern when the fetch itself failed", async () => {
  const { calls, logs, done } = lander(
    declared({
      fetched: false,
      masterVersion: "0.1.21",
      branchVersion: "0.1.21",
      touchesPlugin: false,
      notes: "git fetch did not print FETCHED",
    }),
  );
  const out = await done;

  assert.equal(
    out.stopped[0]?.why,
    "fetch_failed",
    "a failed fetch was waved through on scope. Every ref after it is whatever the checkout " +
      "already held, so a stale origin/master diffs and shows perfectly well - and land-one.sh " +
      "swallows its own fetch error, reads the branch as not behind, rebases nothing and merges " +
      `it on a master it was never tested against: ${JSON.stringify(out.stopped)}`,
  );
  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `the merge step ran on stale refs: ${labels(calls)}`);
  assert.equal(calls.filter((c) => c.label.startsWith("retire:")).length, 0, `it was un-queued on ignorance: ${labels(calls)}`);
  assert.deepEqual(out.landed, [], JSON.stringify(out.landed));
  assert.ok(
    logs.some((l) => /fetch/i.test(l)),
    `the run log does not name the fetch as the reason it stopped: ${logs.join("\n")}`,
  );
});

test("land.js refuses a failed fetch on a plugin branch too, whatever the numbers say", async () => {
  const { calls, done } = lander(declared({ fetched: false, masterVersion: "0.1.21", branchVersion: "0.1.22", notes: "fatal: could not read from remote repository" }));
  const out = await done;

  assert.equal(out.stopped[0]?.why, "fetch_failed", JSON.stringify(out.stopped));
  assert.match(out.stopped[0]?.detail || "", /could not read from remote repository/);
  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, labels(calls));
});

test("the version prompt asks for the fetch as its own field, not as a manifest verdict", async () => {
  const { calls, done } = lander(declared());
  await done;

  const prompt = calls.find((c) => c.label.startsWith("version:"))?.prompt || "";
  assert.match(prompt, /fetched/, "the step has no field to report a failed fetch in");
  assert.ok(
    !/FETCHED did not print, or ls-tree/.test(prompt),
    "the prompt still folds a failed fetch into status, which the version verdict skips entirely " +
      "for a branch that touches no plugin file",
  );
});

test("land.js says in the run log when the versions were left uncompared over a manifest it could not read", async () => {
  const { logs, done } = lander(
    declared({ status: "unreadable", masterVersion: "", branchVersion: "", touchesPlugin: false, notes: "git show origin/master exited 128" }),
  );
  await done;

  assert.ok(
    logs.some((l) => /not compared/.test(l) && /git show origin\/master exited 128/.test(l)),
    "the not-compared line reads identically for a repository that has no plugin number and one " +
      `whose manifest could not be read, so nobody can tell the two apart: ${logs.join("\n")}`,
  );
});
