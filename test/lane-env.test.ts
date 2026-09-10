import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const EXPORTS = "export GIT_CONFIG_GLOBAL=/dev/null BUNDLE_USER_CONFIG=/dev/null";
const IDENTITY =
  'git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)"';

function carries(prompt: string, label: string) {
  assert.ok(
    prompt.includes(EXPORTS),
    `${label} hands out git and bundler commands without the two exports in front of them. An ` +
      "unreadable home-directory config makes every git command fail and every bundler-fronted " +
      "command hang with no output, and a hang is indistinguishable from a slow machine.",
  );
  assert.ok(
    prompt.includes(IDENTITY),
    `${label} does not say how to write a commit once the home config is out of the picture. ` +
      "Identity is the one thing those exports take away, and git either refuses the commit or " +
      "records the wrong author.",
  );
}

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { site: { path: "repo", test: "npm test", lint: "npm run lint", role: "node" } },
};

const TRIAGE_OK = {
  eligible: true,
  repo: "site",
  title: "a lane stalls on a home-directory config",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

function fixCalls(calls: Call[]): Call[] {
  const found = calls.filter((c) => c.label.startsWith("fix:"));
  assert.ok(found.length > 0, `no fix step was run. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found;
}

test("the fix brief carries the exports and the commit identity, on the first attempt and on a rework", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (call.label.startsWith("fix:")) {
      return { status: "pushed", summary: "fixed", prNumber: 9, prUrl: "https://example.test/pr/9" };
    }
    if (call.label.startsWith("review:")) {
      return n === 3
        ? { approved: false, blocking: ["the test proves nothing"], notes: "" }
        : { approved: true, notes: "good" };
    }
    if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 9, notes: "" };
    return { lane: "released", slot: "released" };
  });

  await done;
  const attempts = fixCalls(calls);
  assert.ok(attempts.length > 1, "the rework attempt never ran, so the second brief was not checked");
  attempts.forEach((call, i) => carries(call.prompt, `the fix brief on attempt ${i + 1}`));
  const first = attempts[0];
  assert.ok(first, "no fix attempt was run at all");
  assert.ok(
    first.prompt.includes(`  ${EXPORTS}\n  cd /root/repo`),
    "the worktree setup still opens with a bare cd, so the very first git command of the run goes " +
      "through the home config",
  );
});

test("the reviewer is told the same thing, because it reverts the fix and re-runs the suite", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (call.label.startsWith("fix:")) {
      return { status: "pushed", summary: "fixed", prNumber: 9, prUrl: "https://example.test/pr/9" };
    }
    if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
    if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 9, notes: "" };
    return { lane: "released", slot: "released" };
  });

  await done;
  const review = calls.find((c) => c.label.startsWith("review:"));
  assert.ok(review, `no review step was run. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  carries(review.prompt, "the review brief");
});

const LAND_ARGS = {
  skillDir: "/skill",
  root: "/root",
  repos: { site: { path: "cli", slug: "404sl/pitwall" } },
};

const PR = {
  slug: "404sl/pitwall",
  number: 80,
  title: "Verify the lane rescue diff before removing the worktree",
  branch: "devloop/pitwall-maz",
  issue: "pitwall-maz",
};

test("the lander's version step carries them, which is the step an unreadable config stops first", async () => {
  const { calls, done } = runScript("land.js", LAND_ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: "lander-1", holder: "lander-1" };
    if (call.label.startsWith("survey")) return n === 2 ? { prs: [PR] } : { prs: [] };
    if (call.label.startsWith("version:")) {
      return {
        status: "read",
        masterVersion: "0.1.23",
        branchVersion: "0.1.25",
        touchesPlugin: true,
        labelled: true,
        open: true,
        notes: "",
      };
    }
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: "a".repeat(40), masterGreen: true, notes: "" };
    return { status: "released" };
  });

  await done;
  const version = calls.find((c) => c.label.startsWith("version:"));
  assert.ok(version, `no version step was run. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  carries(version.prompt, "the lander's version brief");
  const land = calls.find((c) => c.label.startsWith("land:"));
  assert.ok(land, "no land step was run");
  carries(land.prompt, "the lander's merge brief");
  assert.ok(
    land.prompt.includes(`${IDENTITY} rebase origin/master`),
    "the rebase the lander is told to run carries no identity. A rebase with none fails, and the " +
      "script that wraps it reports that failure as a conflict with master, which is a decision " +
      "handed to a person for a reason that is not true",
  );
});

test("a rework brief carries them too, for the merge commit it has to write by hand", async () => {
  const { calls, done } = runScript(
    "rework.js",
    { ...LAND_ARGS, pr: 80, id: "pitwall-maz", repo: "site", slot: 3, lockPrefix: "pw" },
    (call: Call) => {
      if (call.label.startsWith("resolve")) {
        return { status: "resolved", branch: PR.branch, oldHead: "a".repeat(40), newHead: "b".repeat(40), notes: "" };
      }
      if (call.label.startsWith("handoff")) return { status: "verified", notes: "" };
      return { lane: "released", slot: "released" };
    },
  );

  await done;
  for (const call of calls) {
    if (call.label.startsWith("release")) continue;
    carries(call.prompt, `the rework ${call.label || "step"} brief`);
  }
});
