import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

// Rule 12 tells a run that every 'gh pr' command carries '--repo', and that the slug for the run
// is named above. That was true of the handoff brief, which interpolates it into its own commands,
// and false of the fix brief, which printed the repository's PATH and nothing else - so the step
// that opens the pull request had the rule and no value to pass it. A wrong slug there does not
// fail: pull request numbers overlap across the repositories in one workspace, so 'gh pr create'
// against the wrong one opens the pull request in the wrong place and answers successfully.
const REPOS = {
  site: { path: "cli", slug: "404sl/pitwall", role: "node", test: "npm test", lint: "npm run lint" },
  integration: { path: "schema", slug: "404sl/pitwall-schema", role: "node", test: "npm test", lint: "npm run lint" },
  docs: { path: "site", slug: "404sl/pitwall-site", role: "rails", test: "bundle exec rspec", lint: "bundle exec rubocop" },
};

const UNSLUGGED = {
  ...REPOS,
  extension: { path: "extension", role: "node", test: "npm test", lint: "npm run lint" },
};

const ARGS = { id: "zz-aaa1", slot: 3, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: REPOS };

const RULES = "0. WRITE bd TEXT THROUGH A FILE";

async function worked(repo: string, repos: unknown = REPOS): Promise<Call[]> {
  const { calls, done } = runScript("task.js", { ...ARGS, repos }, (call, n) => {
    if (n === 1) {
      return { eligible: true, repo, title: "a brief with no slug in it", priority: 2, ui: false, reason: "", ticket: "the ticket body" };
    }
    if (call.label.startsWith("fix:")) {
      return { status: "pushed", summary: "fixed", prNumber: 47, prUrl: "https://example.test/pr/47" };
    }
    if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
    if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 47, notes: "" };
    return { lane: "released", slot: "released" };
  });
  await done;
  return calls;
}

async function split(): Promise<Call[]> {
  const { calls, done } = runScript("task.js", ARGS, (call, n) => {
    if (n === 1) {
      return {
        eligible: false,
        splittable: true,
        splitPlan: [
          { title: "the first half", repo: "site", scope: "the fix brief", autonomous: true },
          { title: "the second half", repo: "site", scope: "the handoff brief", autonomous: true },
        ],
        repo: "site",
        title: "two halves in one ticket",
        priority: 2,
        ui: false,
        reason: "it bundles two fixes",
        ticket: "the ticket body",
      };
    }
    return { lane: "released", slot: "released" };
  });
  await done;
  return calls;
}

function step(calls: Call[], prefix: string): Call {
  const found = calls.find((c) => c.label.startsWith(prefix));
  assert.ok(found, `no ${prefix} step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return found;
}

function aboveTheRules(prompt: string): string {
  const at = prompt.indexOf(RULES);
  assert.notEqual(at, -1, "this brief carries no rules block, so nothing in it promises a slug");
  return prompt.slice(0, at);
}

test("the fix brief names the slug of the repository its ticket lives in", async () => {
  for (const [repo, { slug }] of Object.entries(REPOS)) {
    const fix = step(await worked(repo), "fix:");
    assert.match(
      fix.prompt,
      new RegExp(`^Slug: ${slug}$`, "m"),
      `the fix brief for ${repo} never names ${slug}, so the step that runs 'gh pr create --repo' ` +
        "has no value to pass and guesses one. A guess is not caught: numbers overlap across the " +
        "repositories of one workspace, so the pull request opens in the wrong repository and the " +
        "command succeeds",
    );
  }
});

test("every brief that hands out a gh command names this run's slug above its rules", async () => {
  const runs = [...(await worked("site")), ...(await split())];
  const carriers = runs.filter((c) => c.prompt.includes(RULES));
  assert.ok(carriers.length > 1, `only ${carriers.length} brief carried the rules, so this checks almost nothing`);
  const handing = carriers.filter((c) => /gh pr /.test(aboveTheRules(c.prompt)));
  assert.ok(handing.length > 1, "no brief of this run hands out a gh command of its own, so the rule was never exercised");
  for (const call of handing) {
    assert.match(
      aboveTheRules(call.prompt),
      new RegExp(`${REPOS.site.slug}(?![-\\w])`),
      `the ${call.label || "unlabelled"} brief sends a run to 'gh' and then tells it the slug is named ` +
        "above, where no slug is. The rule is only as good as the value behind it, and a brief that " +
        "states it without one teaches the run to supply its own",
    );
  }
});

test("a repository with no configured slug is told how to read its own, not that there is none", async () => {
  const fix = step(await worked("extension", UNSLUGGED), "fix:");
  const above = aboveTheRules(fix.prompt);
  assert.ok(
    above.includes("git -C /root/extension remote get-url origin"),
    "the fix brief for a repository whose configuration carries no slug names no way to obtain one, " +
      "while the same brief still tells the run to open the pull request with 'gh pr create' and the " +
      "rules still demand '--repo' on it. A brief that states a value is unavailable and asks for it " +
      "anyway is answered with a guess:\n" +
      above.split("\n").slice(0, 8).join("\n"),
  );
  assert.doesNotMatch(
    above,
    /<owner\/name>/,
    "the fix brief hands the run a placeholder to substitute rather than a command to run. A lane that " +
      "guessed one of these bypassed the compliance gate by hand",
  );
});
