import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const RULE = "KILL BY THE PID YOU RECORDED";
const SHELL_FIRST = "EVERY COMMAND THAT RUNS git OR bundle";

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
  title: "a cleanup step kills the process running the lane",
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
        ? { approved: false, blocking: ["the browser was left running"], notes: "" }
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

function rule(brief: string, label: string): string {
  const start = brief.indexOf(RULE);
  assert.ok(
    start > 0,
    `${label} never tells the lane to kill what it launched by the pid it recorded. A lane that ` +
      "cleans up a headless browser with a pattern kill on a path substring matches the shell " +
      "wrapping the command it is cleaning up, because that shell carries the command in its own " +
      "argv - so the lane can kill the process it is running inside, and the failure that follows " +
      "looks like an environment fault rather than a self-inflicted one.",
  );
  const end = brief.indexOf(SHELL_FIRST, start);
  assert.ok(end > start, `${label} puts the kill-by-pid rule somewhere other than in the rules block before the shell exports`);
  return brief.slice(start, end);
}

test("the fix brief tells a lane to kill only what it launched, by pid, on the first attempt and on a rework", async () => {
  const attempts = await fixAttempts();
  attempts.forEach((call, i) => {
    const label = `the fix brief on attempt ${i + 1}`;
    const brief = call.prompt;
    assert.equal(brief.includes("`"), false, `${label} carries a backtick, which closes its template literal early`);

    const block = rule(brief, label);
    assert.match(
      block,
      /never 'pkill -f' on a path or (a )?flag\s+substring/i,
      `${label} says to kill by pid but never forbids the pattern kill a lane reaches for, which is ` +
        "the thing that matched its own wrapper shell",
    );
    assert.match(
      block,
      /full argument list of every\s+process/i,
      `${label} forbids the pattern kill without saying why: that pkill -f matches every argv on the ` +
        "machine, which is what makes a substring of a path reach a shell, a daemon or another lane",
    );
    assert.ok(
      block.includes("'pgrep -f' first"),
      `${label} leaves a lane that did not record the pid with no safe way to find its process; it ` +
        "has to pgrep first and read the matches before anything is killed",
    );
    assert.match(
      block,
      /print every\s+match/i,
      `${label} tells the lane to pgrep but not to print what matched, so nothing in the output ` +
        "says what else was killed",
    );
    assert.match(
      block,
      /only the pids whose command starts with the intended\s+binary/i,
      `${label} lets a pattern match kill by argv substring; only a pid whose command starts with ` +
        "the binary the lane launched is its own",
    );
    assert.match(
      block,
      /leave it running and\s+say so/i,
      `${label} gives a lane that cannot identify its browser no alternative to killing by pattern; ` +
        "leaving it running and saying so is the correct outcome",
    );
    assert.match(
      block,
      /operation not permitted/i,
      `${label} does not name the tell - a sudden permission failure across the session right after ` +
        "a cleanup - so the next lane reports it as an environment fault",
    );

    const recommends = brief
      .split("\n")
      .filter((line) => line.includes("pkill"))
      .filter((line) => !/never|matches/i.test(line));
    assert.deepEqual(recommends, [], `${label} names pkill somewhere other than the prohibition:\n${recommends.join("\n")}`);
  });
});
