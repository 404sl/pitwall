import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "land-train-1788964650-29574",
  repos: {
    site: { path: "cli", slug: "404sl/pitwall" },
  },
};

const TOKEN = "land-train-1788964650-29574";
const UNREADABLE = "gh exited 1 and said: API rate limit already exceeded";

function train(verdict: unknown, included: number[]) {
  return runScript("land-train.js", { ...ARGS, repo: "site" }, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", holder: TOKEN };
    if (call.label.startsWith("build:")) {
      return { status: "built", trainPr: 120, trainBranch: "release/train-1", included, skipped: [] };
    }
    if (call.label.startsWith("verify:")) return verdict;
    if (call.label === "left-behind") {
      return { repos: [{ repo: "site", status: "read", labelled: included }] };
    }
    return { status: "released" };
  });
}

function labels(calls: Call[]): string[] {
  return calls.map((c) => c.label);
}

test("a verdict of 'unknown' stops the train without retiring it, bisecting it or rejecting anything", async () => {
  const { calls, done } = train({ status: "unknown", notes: UNREADABLE }, [1287, 1288]);
  const result = await done;

  assert.equal(
    result.stopped,
    "checks_unreadable",
    "an unreadable rollup is reported as some other stop reason - it must not share one with a red train",
  );
  assert.equal(result.notes, UNREADABLE, "the verify step's own sentences are not reported verbatim");
  assert.deepEqual(result.rejected, [], "an unreadable rollup pushed the pull requests it carried into rejected");
  assert.deepEqual(result.landed, [], "an unreadable rollup landed something");

  const ran = labels(calls);
  assert.equal(
    ran.some((l) => l.startsWith("retire:")),
    false,
    `the train was retired on checks that could not be read: ${ran.join(", ")}`,
  );
  assert.equal(
    ran.filter((l) => l.startsWith("build:")).length,
    1,
    `the train bisected on checks that could not be read, which cuts a release branch per half: ${ran.join(", ")}`,
  );
  assert.equal(
    ran.some((l) => l.startsWith("merge:") || l.startsWith("version:")),
    false,
    `the train went on towards a merge on checks that could not be read: ${ran.join(", ")}`,
  );
});

test("a verify step that reports nothing at all is unreadable, not red", async () => {
  const { calls, done } = train(undefined, [1287, 1288]);
  const result = await done;

  assert.equal(result.stopped, "checks_unreadable");
  assert.equal(result.notes, "verify agent returned nothing");
  assert.deepEqual(result.rejected, []);
  const ran = labels(calls);
  assert.equal(ran.some((l) => l.startsWith("retire:")), false, `a silent verify step retired the train: ${ran.join(", ")}`);
});

test("a verdict of 'red' still retires the train and hands the branch back", async () => {
  const { calls, done } = train({ status: "red", failingSpecs: ["./spec/system/board_spec.rb:42"] }, [1287]);
  const result = await done;

  assert.equal(result.stopped, null, "a red train of one identifies the culprit and does not stop the run");
  assert.deepEqual(result.rejected, [1287], "a red train of one did not hand its pull request back");
  const ran = labels(calls);
  assert.equal(
    ran.some((l) => l.startsWith("retire:")),
    true,
    `a red train was not retired, so its branch sits on the remote looking like open work: ${ran.join(", ")}`,
  );
});

test("the verify step is told what to do when the tool ceiling cuts the watch", async () => {
  const { calls, done } = train({ status: "unknown", notes: UNREADABLE }, [1287]);
  await done;

  const verify = calls.find((c) => c.label.startsWith("verify:"));
  assert.ok(verify, "no verify step ran");
  assert.match(
    verify.prompt,
    /timeout: 600000/,
    "the watch is run without the Bash tool's ceiling on the call, so it is cut after two minutes instead of ten",
  );
  assert.match(
    verify.prompt,
    /RUN THE SAME WATCH AGAIN ON THE SAME PULL REQUEST/,
    "nothing tells the step to keep watching across calls when the ceiling cuts the watch, so a suite longer than the ceiling reads as unknown",
  );
  assert.match(
    verify.prompt,
    /A CUT CALL IS NOT AN ANSWER/,
    "the step may read a cut watch as a verdict",
  );
  assert.match(verify.prompt, /AN EMPTY check_runs ARRAY IS NOT A PASS/, "an empty check_runs array reads as a pass");
  assert.doesNotMatch(
    verify.prompt,
    /^\s+(cd \S+ && )?gh pr (list|view) /m,
    "the verify step runs a GraphQL read",
  );
  assert.equal(verify.prompt.includes("`"), false, "a backtick in the verify brief closes its template literal early");
});
