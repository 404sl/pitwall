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
  status: string;
  masterVersion: string;
  branchVersion: string;
  touchesPlugin: boolean;
  labelled?: boolean;
  open?: boolean;
  notes: string;
};

function declared(over: Partial<Declared> = {}): Declared {
  return {
    status: "read",
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

test("land.js refuses a branch whose plugin version equals master's, naming both numbers", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.21" }));
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    0,
    `the merge step ran on a branch declaring the version master already holds. Steps: ${labels(calls)}`,
  );
  assert.deepEqual(out.landed, []);
  const stopped = out.stopped.find((s) => s.number === 80);
  assert.ok(stopped, `nothing was reported as stopped: ${JSON.stringify(out.stopped)}`);
  assert.equal(stopped.why, "version_not_ahead");
  assert.match(stopped.detail || "", /0\.1\.21/);
  assert.ok(
    (stopped.detail || "").includes("0.1.21") && /origin\/master holds 0\.1\.21/.test(stopped.detail || ""),
    `the refusal does not name both numbers: ${stopped.detail}`,
  );
});

test("land.js refuses a branch whose plugin version is lower than master's, naming both numbers", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.17" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `the merge step ran: ${labels(calls)}`);
  const stopped = out.stopped.find((s) => s.number === 80);
  assert.ok(stopped);
  assert.equal(stopped.why, "version_not_ahead");
  assert.match(stopped.detail || "", /0\.1\.17/);
  assert.match(stopped.detail || "", /0\.1\.21/);
});

test("land.js lands a branch whose plugin version is strictly greater", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.22" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 1, `the merge step did not run: ${labels(calls)}`);
  assert.deepEqual(out.stopped, []);
  assert.equal(out.landed.length, 1);
});

test("land.js compares the numbers rather than the strings, so 0.1.9 does not outrank 0.1.21", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.9" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `the merge step ran: ${labels(calls)}`);
  assert.equal(out.stopped[0]?.why, "version_not_ahead");
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

test("land.js refuses rather than merges when a version is not three numbers", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "v0.1.22-rc" }));
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `an unparseable version let the merge through: ${labels(calls)}`);
  assert.equal(out.stopped[0]?.why, "version_unreadable");
  assert.match(out.stopped[0]?.detail || "", /v0\.1\.22-rc/);
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

test("land.js reads master's version once per pull request, after the one before it merged", async () => {
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
  assert.deepEqual(out.landed.map((l) => l.number), [80]);
  assert.equal(out.stopped.find((s) => s.number === 81)?.why, "version_not_ahead");
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

test("land.js un-queues a pull request refused on its version, so the next run does not rediscover it", async () => {
  const { calls, done } = lander(declared({ masterVersion: "0.1.21", branchVersion: "0.1.17" }));
  await done;

  const retire = calls.find((c) => c.label.startsWith("retire:"));
  assert.ok(
    retire,
    `a refusal that nothing can resolve on its own left the label on, so every future run pays for the same refusal. Steps: ${labels(calls)}`,
  );
  assert.match(retire.prompt, /404sl\/pitwall#80/);
  assert.match(retire.prompt, /0\.1\.17/);
  assert.match(retire.prompt, /0\.1\.21/);
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
    `a pull request a lane had pulled back for rework was un-queued on its version, which appends a ` +
      `finding to an issue that lane holds in_progress and reopens it for a second lane. Steps: ${labels(calls)}`,
  );
  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    0,
    `a merge was delegated for a branch whose number is behind, and land-one.sh never reads a ` +
      `version - so the label being gone turned the guard off rather than holding it: ${labels(calls)}`,
  );
  assert.deepEqual(
    out.stopped.filter((s) => s.why === "version_not_ahead"),
    [],
    `refused on a number it was no longer in the queue to declare: ${JSON.stringify(out.stopped)}`,
  );
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
  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `a merge was delegated anyway: ${labels(calls)}`);
  assert.deepEqual(out.stopped.filter((s) => s.why === "version_not_ahead"), [], JSON.stringify(out.stopped));
});

test("land.js refuses but keeps queued a branch whose version is behind when the queue state was not read", async () => {
  const reply = declared({ masterVersion: "0.1.21", branchVersion: "0.1.17" });
  delete reply.labelled;
  delete reply.open;
  const { calls, done } = lander(reply);
  const out = await done;

  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, `the merge ran anyway: ${labels(calls)}`);
  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    `a step that reported no queue state un-queued a pull request anyway: ${labels(calls)}`,
  );
  assert.equal(out.stopped[0]?.why, "version_unreadable");
  assert.match(out.stopped[0]?.detail || "", /0\.1\.17/);
  assert.match(out.stopped[0]?.detail || "", /lane-verified/);
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

test("land.js does not merge a behind version because the step reported the label gone", async () => {
  const { calls, logs, done } = lander(
    declared({ masterVersion: "0.1.21", branchVersion: "0.1.17", labelled: false }),
    { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" },
  );
  const out = await done;

  assert.deepEqual(
    out.landed,
    [],
    `a branch declaring 0.1.17 merged over master's 0.1.21 because one haiku read - or a lane ` +
      `re-labelling between the read and land-one.sh's own check - turned the version guard off ` +
      `rather than handing it over: ${JSON.stringify(out.landed)}`,
  );
  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    0,
    `the merge was delegated to land-one.sh, which checks the label and the checks and never a ` +
      `version, so nothing downstream would have compared the numbers: ${labels(calls)}`,
  );
  assert.equal(calls.filter((c) => c.label.startsWith("retire:")).length, 0, `it was un-queued: ${labels(calls)}`);
  assert.ok(
    logs.some((l) => /DEFERRED/.test(l) && l.includes("0.1.17") && l.includes("0.1.21") && l.includes("lane-verified")),
    `the deferral left nothing a person could act on: a number that is behind and a label that is ` +
      `gone are two different things to fix, and the log names neither: ${logs.join("\n")}`,
  );
});

test("land.js does not merge a behind version because the step reported it closed either", async () => {
  const { calls, done } = lander(
    declared({ masterVersion: "0.1.21", branchVersion: "0.1.17", open: false }),
    { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" },
  );
  const out = await done;

  assert.deepEqual(out.landed, [], JSON.stringify(out.landed));
  assert.equal(calls.filter((c) => c.label.startsWith("land:")).length, 0, labels(calls));
  assert.equal(calls.filter((c) => c.label.startsWith("retire:")).length, 0, labels(calls));
});

test("land.js does not merge an uncomparable version because the step reported the label gone", async () => {
  const { calls, done } = lander(
    declared({ masterVersion: "0.1.21", branchVersion: "v0.1.22-rc", labelled: false }),
    { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" },
  );
  const out = await done;

  assert.deepEqual(
    out.landed,
    [],
    `a version nobody can order against anything merged because the queue state came back false: ` +
      `a label that is gone says who decides whether this pull request is still wanted, not whether ` +
      `an unreadable number is ahead: ${JSON.stringify(out.landed)}`,
  );
  assert.equal(out.stopped[0]?.why, "version_unreadable");
  assert.equal(calls.filter((c) => c.label.startsWith("retire:")).length, 0, `it was un-queued on ignorance: ${labels(calls)}`);
});
