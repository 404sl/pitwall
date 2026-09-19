import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const IDENTITY =
  'git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)"';
const COMMIT_EARLY = "COMMIT AS SOON AS THE CHANGE COMPILES";
const SQUASH =
  'git reset --soft "$(git merge-base --is-ancestor origin/devloop/zz-aaa1 HEAD 2>/dev/null && git rev-parse origin/devloop/zz-aaa1 || git rev-parse origin/master)"';

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
  title: "a fix step dies with its work uncommitted",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body",
};

async function fixAttempts(): Promise<Call[]> {
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
  const found = calls.filter((c) => c.label.startsWith("fix:"));
  assert.ok(found.length > 1, `the rework attempt never ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found;
}

function paragraph(brief: string, label: string): string {
  const start = brief.indexOf(COMMIT_EARLY);
  assert.ok(
    start > 0,
    `${label} never tells the lane to commit its work as it goes. kill-lane.sh, slot.sh --gc and a ` +
      "re-dispatch that recreates the worktree all delete uncommitted files, and each is the " +
      "documented response to a stuck lane - so a fix step that dies mid-suite leaves nothing " +
      "behind but a worktree the next dispatch destroys.",
  );
  const end = brief.indexOf("\n5. ", start);
  assert.ok(end > start, `${label} puts the commit-as-you-go instruction somewhere other than before step 5`);
  return brief.slice(start, end);
}

test("the fix brief tells a lane to commit as it goes, on the first attempt and on a rework", async () => {
  const attempts = await fixAttempts();
  attempts.forEach((call, i) => {
    const label = `the fix brief on attempt ${i + 1}`;
    const brief = call.prompt;
    assert.equal(brief.includes("`"), false, `${label} carries a backtick, which closes its template literal early`);

    const block = paragraph(brief, label);
    assert.match(
      block,
      /before (anything|every long-running step|any long-running step)/i,
      `${label} says to commit once the change compiles but not again before the full suite or a CI ` +
        "wait, which is where a run spends most of its life and where it is most likely to be stopped",
    );
    assert.ok(
      block.includes(`${IDENTITY} commit -F`),
      `${label} tells the lane to commit early but not with the identity on the command, so the ` +
        "interim commit either fails outright or is stamped with a hostname-derived author",
    );
    assert.ok(
      block.includes("kill-lane.sh") && block.includes("slot.sh --gc"),
      `${label} does not name the tools that delete uncommitted work, so the lane has no reason to ` +
        "believe a commit is worth the interruption",
    );
    assert.ok(
      block.includes(SQUASH) && block.includes(`${IDENTITY} commit -F`),
      `${label} lets an interim commit reach the pushed branch as it stands: it never says to fold ` +
        "them into one commit, reset to the head the remote holds when the branch is published and to " +
        `origin/master when it is not. Offered:\n${block}`,
    );

    const early = brief.indexOf(COMMIT_EARLY);
    const check = brief.indexOf("--pre-push", early);
    const open = brief.indexOf("gh pr create", early);
    assert.ok(check > 0 && open > 0, `${label} lost the pre-push check or the pull request command`);
    assert.ok(
      early < check && check < open,
      `${label} orders the steps as commit-early at ${early}, pre-push at ${check}, pull request at ` +
        `${open}; the interim commits must exist before the check reads them and the check before the push`,
    );
  });
});
