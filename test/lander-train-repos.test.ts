import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call, type Reply } from "./support/workflow.js";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  repos: {
    site: { path: "cli", slug: "404sl/pitwall", deploy: ["staging"] },
    docs: { path: "site", slug: "404sl/pitwall-site" },
  },
};

const TOKEN = "land-train-1788964650-29574";
const SHA = "e1a54123ca4d0b6a32479f49da4d26893f648206";

type Account = {
  slug: string | null;
  train: boolean;
  surveyed: number | null;
  taken: number;
  left: number | null;
  leftPrs: number[];
  relaunch: string | null;
  why: string | null;
};

type Result = {
  status?: string;
  notes?: string;
  repo?: string;
  slug?: string;
  repos?: Record<string, Account>;
  landed?: number[];
};

function account(out: Result, name: string): Account {
  const found = (out.repos || {})[name];
  assert.ok(found, `no accounting for ${name}: ${JSON.stringify(out.repos)}`);
  return found;
}

function train(reply: Reply, args: Record<string, unknown> = {}) {
  return runScript("land-train.js", { ...ARGS, repo: "site", ...args }, (call, n) => {
    if (n === 1) return { status: "taken", token: TOKEN, holder: TOKEN };
    return reply(call, n);
  });
}

function branchSurvey(included: number[]) {
  const branches = included.map((n) => ({ number: n, branch: `devloop/pitwall-${n}` }));
  return {
    status: "read",
    branches,
    asked: branches.flatMap(({ branch }) => [
      { slug: "404sl/pitwall", branch },
      { slug: "404sl/pitwall-site", branch },
    ]),
    open: [],
  };
}

function oneLandedInSite(survey: unknown, included: number[] = [1287]): Reply {
  return (call: Call) => {
    if (call.label.startsWith("build:")) {
      return { status: "built", trainPr: 120, trainBranch: "release/train-1", included, skipped: [] };
    }
    if (call.label.startsWith("verify:")) return { status: "green", failingSpecs: [] };
    if (call.label.startsWith("version:")) {
      return {
        status: "no_manifest",
        masterVersion: "",
        branchVersion: "",
        touchesPlugin: false,
        notes: "this repository carries no devloop plugin manifest on master",
      };
    }
    if (call.label.startsWith("merge:")) return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    if (call.label === "branch-survey") return branchSurvey(included);
    if (call.label === "left-behind") return survey;
    return { status: "released" };
  };
}

const BOTH_LABELLED = {
  repos: [
    { repo: "site", status: "read", labelled: [1287] },
    { repo: "docs", status: "read", labelled: [185] },
  ],
};

test("a train refuses to run when no repo was named, rather than choosing one", async () => {
  const { calls, done } = runScript("land-train.js", { ...ARGS }, () => {
    throw new Error("no step should have run");
  });
  const out = (await done) as Result;

  assert.equal(out.status, "error", `a train with no repo returned ${JSON.stringify(out)}`);
  assert.match(out.notes || "", /no repo was supplied/);
  assert.match(out.notes || "", /site/);
  assert.match(out.notes || "", /docs/);
  assert.deepEqual(
    calls.map((c) => c.label),
    [],
    "the merge lock was taken before the run knew which repository it was for. The fallback it " +
      "replaced selected 'site' silently, so a supervisor who had never heard of args.repo got " +
      "one repository chosen for them with nothing in the result saying a choice was made.",
  );
});

test("a train names the repository it ran for in its own result", async () => {
  const { done } = train(oneLandedInSite(BOTH_LABELLED));
  const out = (await done) as Result;

  assert.equal(out.repo, "site", `the result names no repository: ${JSON.stringify(out)}`);
  assert.equal(out.slug, "404sl/pitwall");
});

test("a labelled pull request in another configured repo is reported, with the train to run for it", async () => {
  const { calls, done } = train(oneLandedInSite(BOTH_LABELLED));
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(docs.left, 1, "the pull request this run never looked at is not in the result");
  assert.deepEqual(docs.leftPrs, [185]);
  assert.equal(docs.taken, 0);
  assert.equal(docs.surveyed, 1);
  assert.match(
    docs.relaunch || "",
    /repo: docs/,
    "the result says a pull request was left but not what to do about it. args.repo is the answer " +
      "and nobody knew it existed, so 'left behind' alone makes a supervisor hand-merge - which " +
      "ships the content and skips the release branch, the close step and this accounting.",
  );
});

test("the survey of the other repos runs after the merge and the close, before the lock goes back", async () => {
  const { calls, done } = train(oneLandedInSite(BOTH_LABELLED));
  await done;

  const order = calls.map((c) => c.label);
  const survey = order.indexOf("left-behind");
  const release = order.indexOf("release");
  const merge = order.findIndex((l) => l.startsWith("merge:"));
  const close = order.lastIndexOf("close");
  assert.ok(survey >= 0, `no survey of the other repositories ran: ${order.join(", ")}`);
  assert.ok(release >= 0, `no release step ran: ${order.join(", ")}`);
  assert.ok(merge >= 0, `no merge step ran: ${order.join(", ")}`);
  assert.ok(close >= 0, `no close step ran: ${order.join(", ")}`);
  assert.ok(
    survey < release,
    `the lock was released before the run had looked at the other repositories: ${order.join(", ")}.`,
  );
  assert.ok(
    survey > merge && survey > close,
    `the survey ran before this train had finished its own work: ${order.join(", ")}. It has to be ` +
      "late rather than early: the halves of a two-repo ticket arrive minutes apart, so a survey " +
      "taken before the merge misses the case it exists for.",
  );
});

test("a pull request labelled in the other repo while this train ran is still reported", async () => {
  let merged = false;
  const { calls, done } = train((call: Call) => {
    if (call.label.startsWith("build:")) {
      return { status: "built", trainPr: 120, trainBranch: "release/train-1", included: [1287], skipped: [] };
    }
    if (call.label.startsWith("verify:")) return { status: "green", failingSpecs: [] };
    if (call.label.startsWith("version:")) {
      return {
        status: "no_manifest",
        masterVersion: "",
        branchVersion: "",
        touchesPlugin: false,
        notes: "this repository carries no devloop plugin manifest on master",
      };
    }
    if (call.label.startsWith("merge:")) {
      merged = true;
      return { status: "merged", mergeSha: SHA, masterGreen: true, notes: "" };
    }
    if (call.label === "branch-survey") return branchSurvey([1287]);
    if (call.label === "left-behind") {
      return {
        repos: [
          { repo: "site", status: "read", labelled: [1287] },
          { repo: "docs", status: "read", labelled: merged ? [185] : [] },
        ],
      };
    }
    return { status: "released" };
  });
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(
    docs.left,
    1,
    "the second repository's half was labelled while this train was still merging its own, and the " +
      "survey read an empty queue for it. The halves of a two-repo ticket arrive MINUTES APART - " +
      "that is what made this loss hard to see - so a survey taken at the top of the run, or " +
      "anywhere before the merge, reports a clean zero for the repository that holds the work. A " +
      "fixture with both repositories labelled from the first call cannot tell the two placements " +
      `apart. Call order was: ${calls.map((c) => c.label).join(", ")}.`,
  );
  assert.deepEqual(docs.leftPrs, [185]);
  assert.equal(docs.surveyed, 1);
  assert.equal(docs.taken, 0);
  assert.match(docs.relaunch || "", /repo: docs/);
  assert.equal(account(out, "site").taken, 1);
});

test("a repo that yielded nothing says so with a zero rather than being absent", async () => {
  const { done } = train(
    oneLandedInSite({
      repos: [
        { repo: "site", status: "read", labelled: [] },
        { repo: "docs", status: "read", labelled: [] },
      ],
    }),
  );
  const out = (await done) as Result;

  assert.deepEqual(
    Object.keys(out.repos || {}).sort(),
    ["docs", "site"],
    "a configured repository is missing from the accounting. An absent key and a zero are the same " +
      "thing to a reader and different things in fact.",
  );
  const docs = account(out, "docs");
  assert.equal(docs.surveyed, 0);
  assert.equal(docs.taken, 0);
  assert.equal(docs.left, 0);
  assert.equal(docs.relaunch, null, "a repository with nothing labelled asked for a second train");
  assert.equal(docs.why, null);

  const site = account(out, "site");
  assert.equal(site.train, true);
  assert.equal(site.taken, 1, "the repository the train ran for does not count what it took");
  assert.equal(site.surveyed, 1);
  assert.equal(site.left, 0);
});

test("a repo the survey could not read is unknown, not zero", async () => {
  const { done } = train(
    oneLandedInSite({
      repos: [
        { repo: "site", status: "read", labelled: [] },
        { repo: "docs", status: "unreadable", notes: "gh pr list exited 4: could not resolve to a Repository" },
      ],
    }),
  );
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(docs.surveyed, null, "a repository that could not be read was reported as surveyed");
  assert.equal(docs.left, null, "a failed survey was reported as nothing left, which is the defect");
  assert.match(docs.why || "", /could not resolve to a Repository/);
});

test("a repo the survey left out of its answer is unknown, not zero", async () => {
  const { done } = train(oneLandedInSite({ repos: [{ repo: "site", status: "read", labelled: [] }] }));
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(docs.surveyed, null);
  assert.equal(docs.left, null);
  assert.match(docs.why || "", /reported nothing for this repository/);
});

test("a repo with no slug is reported as unsurveyable rather than clean", async () => {
  const { done } = train(oneLandedInSite({ repos: [{ repo: "site", status: "read", labelled: [] }] }), {
    repos: { site: ARGS.repos.site, docs: { path: "site" } },
  });
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(docs.slug, null);
  assert.equal(docs.surveyed, null);
  assert.match(docs.why || "", /no slug/);
});

test("the accounting survives a survey step that answers with something else entirely", async () => {
  const { done } = train(oneLandedInSite({ status: "released" }));
  const out = (await done) as Result;

  assert.deepEqual(Object.keys(out.repos || {}).sort(), ["docs", "site"]);
  for (const name of ["site", "docs"]) {
    assert.equal(account(out, name).surveyed, null, `${name} was counted from an answer that carried no survey`);
  }
});

test("a train that built nothing still reports what the other repos hold", async () => {
  const { calls, done } = train((call: Call) => {
    if (call.label.startsWith("build:")) return { status: "empty" };
    if (call.label === "left-behind") return BOTH_LABELLED;
    return { status: "released" };
  });
  const out = (await done) as Result;

  assert.ok(
    calls.some((c) => c.label === "left-behind"),
    "a train that found nothing to build skipped the survey - which is the run most likely to be " +
      "the one where the other repository holds the only work in the workspace",
  );
  assert.equal(account(out, "docs").left, 1);
  assert.equal(account(out, "site").taken, 0);
});

test("the survey step is given every configured repository by key and owner/name", async () => {
  const { calls, done } = train(oneLandedInSite(BOTH_LABELLED));
  await done;

  const survey = calls.find((c) => c.label === "left-behind");
  assert.ok(survey, "no survey step ran");
  assert.match(survey.prompt, /site {2}404sl\/pitwall/);
  assert.match(survey.prompt, /docs {2}404sl\/pitwall-site/);
  assert.match(survey.prompt, /--label lane-verified/);
  for (const forbidden of [/gh pr merge/, /gh pr close/, /--add-label/, /--remove-label/]) {
    assert.doesNotMatch(
      survey.prompt,
      forbidden,
      `the survey step is handed a write (${forbidden}). It runs while this train still holds the ` +
        "merge lock and it exists only to report.",
    );
  }
});

test("a number this train landed does not cancel the same number in another repository", async () => {
  const { done } = train(
    oneLandedInSite(
      {
        repos: [
          { repo: "site", status: "read", labelled: [185] },
          { repo: "docs", status: "read", labelled: [185] },
        ],
      },
      [185],
    ),
  );
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(
    docs.left,
    1,
    "a labelled pull request in another repository vanished because this train landed the same " +
      "number in its own. A pull request's identity is slug#number, never a bare number, and the " +
      "two repositories here number in the same range. A zero from a repository the survey read " +
      "is believed, so this is worse than the absent key it replaced.",
  );
  assert.deepEqual(docs.leftPrs, [185]);
  assert.equal(docs.surveyed, 1);
  assert.equal(docs.taken, 0);
  assert.equal(docs.why, null);
  assert.match(docs.relaunch || "", /repo: docs/);

  const site = account(out, "site");
  assert.equal(site.taken, 1);
  assert.equal(site.left, 0, "the number this train landed was counted as still left in its own repository");
});

test("a labelled pull request left in the train's own repository is explained rather than left bare", async () => {
  const { done } = train(
    oneLandedInSite({
      repos: [
        { repo: "site", status: "read", labelled: [1287, 1300] },
        { repo: "docs", status: "read", labelled: [] },
      ],
    }),
  );
  const out = (await done) as Result;

  const site = account(out, "site");
  assert.equal(site.left, 1);
  assert.deepEqual(site.leftPrs, [1300]);
  assert.equal(site.taken, 1);
  assert.equal(site.surveyed, 2);
  assert.ok(
    site.why,
    "a labelled pull request still open in the repository this train ran for was reported as a " +
      "count with no explanation. It is in neither rejected nor stranded when it was labelled " +
      "after the build surveyed the queue, so the number alone tells a supervisor nothing.",
  );
  assert.equal(site.relaunch, null, "the train's own repository asked for a relaunch for itself");
});

test("a labelled list the survey could not read as numbers is unknown, not zero", async () => {
  const { done } = train(
    oneLandedInSite({
      repos: [
        { repo: "site", status: "read", labelled: [] },
        { repo: "docs", status: "read", labelled: ["185"] },
      ],
    }),
  );
  const out = (await done) as Result;

  const docs = account(out, "docs");
  assert.equal(
    docs.surveyed,
    null,
    "an element that could not be read as a pull request number was dropped, leaving a confident " +
      "zero for a repository that may hold labelled work",
  );
  assert.equal(docs.left, null);
  assert.match(docs.why || "", /185/);
});
