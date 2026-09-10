import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Call = { prompt: string; label: string };
type Reply = (call: Call, n: number) => unknown;
type Result = {
  landed: { repo?: string; slug?: string; number?: number }[];
  stopped: { repo?: string; slug?: string; number?: number; why?: string }[];
  skipped: { repo?: string; slug?: string; number?: number; why?: string }[];
};

function runScript(file: string, args: unknown, reply: Reply) {
  const source = readFileSync(join(SKILL, file), "utf8").replace(/^export const /m, "const ");
  const calls: Call[] = [];
  const body = new AsyncFunction("args", "agent", "phase", "log", "parallel", source);
  const agent = async (prompt: string, opts: { label?: string } = {}) => {
    const call = { prompt, label: opts.label || "" };
    calls.push(call);
    return reply(call, calls.length);
  };
  const noop = () => {};
  return { calls, done: body(args, agent, noop, noop, noop) as Promise<Result> };
}

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  repos: {
    site: { path: "cli", slug: "404sl/pitwall" },
    docs: { path: "site", slug: "404sl/pitwall-site" },
  },
};

const THE_PR = {
  repo: "site",
  slug: "404sl/pitwall-site",
  number: 23,
  title: "A view page for one ticket",
  branch: "devloop/pitwall-abc",
  issue: "pitwall-abc",
};

const NO_PLUGIN = {
  status: "no_manifest",
  masterVersion: "",
  branchVersion: "",
  touchesPlugin: false,
  labelled: true,
  open: true,
  notes: "this repository carries no devloop plugin manifest on master",
};

function lander(reply: Reply, args: Record<string, unknown> = {}) {
  return runScript("land.js", { ...ARGS, ...args }, (call, n) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
    if (call.label === "release") return { status: "released" };
    if (call.label.startsWith("version:")) return NO_PLUGIN;
    return reply(call, n);
  });
}

function landCalls(calls: Call[]) {
  return calls.filter((c) => c.label.startsWith("land:"));
}

test("a surveyed PR is resolved by its repository slug, not by the key the survey named", async () => {
  const { calls, done } = lander((call) => {
    if (call.label.startsWith("survey")) return { prs: [THE_PR] };
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: "c0ffee1", masterGreen: true };
    return { status: "deployed" };
  });
  const result = await done;

  const land = landCalls(calls)[0];
  assert.ok(
    land,
    `no merge was delegated for a labelled PR. Steps seen: ${calls.map((c) => c.label).join(", ")}`,
  );
  assert.match(
    land.prompt,
    /--slug 404sl\/pitwall-site /,
    "the merge was pointed at a repository the survey did not name. 'site' is this workspace's " +
      "key for the CLI checkout and is also how a model describes the website repo, so a key " +
      "cannot identify a repository - every PR number 1-25 exists in both, and #23 was already " +
      "merged in the other one.",
  );
  assert.doesNotMatch(
    land.prompt,
    /404sl\/pitwall /,
    "the merge named the CLI repository for a PR that is in the website repository",
  );
  assert.match(
    land.prompt,
    /--repo-path \/root\/site /,
    "the checkout was resolved from the survey's key rather than from the slug's configured entry",
  );
  assert.deepEqual(
    result.landed.map((l) => `${l.slug}#${l.number}`),
    ["404sl/pitwall-site#23"],
    "the landed list does not say which repository the merge happened in",
  );
  assert.equal(
    result.landed[0]?.repo,
    "docs",
    "the canonical config key was taken from the survey instead of from the slug that matched",
  );
});

test("a PR whose CI never finished is reported, not dropped", async () => {
  const { calls, done } = lander((call) => {
    if (call.label.startsWith("survey")) return { prs: [THE_PR] };
    if (call.label.startsWith("land:")) return { status: "blocked", notes: "checks still running" };
    return { status: "deployed" };
  });
  const result = await done;

  assert.ok(landCalls(calls).length > 0, "the PR was never attempted at all");
  const accounted = [...result.landed, ...result.stopped, ...result.skipped];
  assert.deepEqual(
    accounted.map((p) => `${p.slug}#${p.number}`),
    ["404sl/pitwall-site#23"],
    "a labelled, green, mergeable PR came back in neither the landed nor the skipped list - the " +
      "run reported nothing at all about it. Deferring on every round and then exhausting the " +
      "round cap is how that happens, and silence is the defect the result shape has to make " +
      "impossible.",
  );
  assert.match(
    result.skipped[0]?.why || "",
    /CI/,
    "the run does not say why the PR was surveyed and not acted on",
  );
});

test("the queue behind a red master is reported rather than forgotten", async () => {
  const second = { ...THE_PR, number: 24, branch: "devloop/pitwall-def", issue: "pitwall-def" };
  const { done } = lander((call) => {
    if (call.label.startsWith("survey")) return { prs: [THE_PR, second] };
    if (call.label.startsWith("land:")) return { status: "master_red", notes: "master was already red" };
    return { status: "retired" };
  });
  const result = await done;

  const accounted = [...result.landed, ...result.stopped, ...result.skipped].map((p) => p.number);
  assert.deepEqual(
    accounted.sort(),
    [23, 24],
    "a PR the run surveyed and never attempted - because master went red in front of it - came " +
      "back in no list at all",
  );
});

test("a pre-flighted PR matches whether it is named by slug or by configured key", async () => {
  for (const preflighted of [["docs#23"], ["404sl/pitwall-site#23"], [{ repo: "docs", number: 23 }]]) {
    const { calls, done } = lander(
      (call) => {
        if (call.label.startsWith("survey")) return { prs: [THE_PR] };
        if (call.label.startsWith("land:")) return { status: "merged", mergeSha: "c0ffee1", masterGreen: true };
        return { status: "deployed" };
      },
      { preflighted },
    );
    const result = await done;

    assert.deepEqual(
      result.landed.map((l) => l.number),
      [23],
      `pre-flighted as ${JSON.stringify(preflighted)} and not landed. The supervisor's list and ` +
        "the survey have to meet on the same identity, and a key the survey chose for itself is " +
        "not one - the PR is filtered out as though it were never labelled.",
    );
    assert.deepEqual(result.skipped, [], `pre-flighted as ${JSON.stringify(preflighted)} and skipped`);
  }
});

test("a surveyed PR in an unconfigured repository is skipped, not thrown over", async () => {
  const { calls, done } = lander((call) => {
    if (call.label.startsWith("survey")) {
      return { prs: [{ slug: "somebody/else", number: 7, title: "not ours", branch: "x" }] };
    }
    if (call.label.startsWith("land:")) return { status: "merged", mergeSha: "c0ffee1", masterGreen: true };
    return { status: "deployed" };
  });
  const result = await done;

  assert.deepEqual(
    landCalls(calls),
    [],
    "a merge was delegated against a repository this workspace does not configure",
  );
  assert.deepEqual(
    result.skipped.map((p) => `${p.slug}#${p.number}`),
    ["somebody/else#7"],
    "an unrecognised repository was neither landed nor reported",
  );
  assert.ok(
    calls.some((c) => c.label === "release"),
    "the merge lock was never given back",
  );
});
