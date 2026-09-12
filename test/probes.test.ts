import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CollectionError } from "@404sl/pitwall-schema";
import { issueMatcher } from "../src/pipeline.ts";
import { preconditionProbe, pullLookup } from "../src/probes.ts";
import { unresolvedOf, type PullReference } from "../src/staleness.ts";
import { dispositionOf } from "../src/problems.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NO_TOOLS = join(FIXTURES, "gh", "missing");
const UNAUTH_GH = `${join(FIXTURES, "gh", "unauth")}:/usr/bin:/bin`;
const NOTFOUND_GH = `${join(FIXTURES, "gh", "notfound")}:/usr/bin:/bin`;
const RATELIMIT_GH = `${join(FIXTURES, "gh", "ratelimit")}:/usr/bin:/bin`;
const GARBLED_GH = `${join(FIXTURES, "gh", "garbled")}:/usr/bin:/bin`;
const SLOW_GH = `${join(FIXTURES, "gh", "slow")}:/usr/bin:/bin`;
const LANDED_GH = `${join(FIXTURES, "gh", "landed")}:/usr/bin:/bin`;

function aReference(over: Partial<PullReference> = {}): PullReference {
  return { number: 12, repo: undefined, url: undefined, text: "#12", ...over };
}

function aRepo(): string {
  return mkdtempSync(join(tmpdir(), "pitwall-probe-"));
}

function aLanding(): (reference: PullReference) => Promise<unknown> {
  return pullLookup({
    repos: new Map([["site", aRepo()]]),
    names: issueMatcher("mw", new Set(["mw-7b1", "mw-9"])),
    env: { PATH: LANDED_GH },
  });
}

test("a precondition that could not be run at all is recorded once, not once per issue", async () => {
  const errors: CollectionError[] = [];
  const probe = preconditionProbe({ env: { PATH: NO_TOOLS }, errors });
  assert.equal(await probe(["npm", "whoami"]), undefined);
  assert.equal(await probe(["npm", "whoami"]), undefined);
  assert.equal(await probe(["npm", "whoami"]), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "npm whoami");
  assert.match(errors[0]?.message ?? "", /ENOENT/);
});

test("a precondition that runs and fails is an answer, not a collection error", async () => {
  const errors: CollectionError[] = [];
  const probe = preconditionProbe({ env: { PATH: UNAUTH_GH }, errors });
  assert.equal(await probe(["gh", "auth", "status"]), false);
  assert.deepEqual(errors, []);
});

test("a probe with nowhere to report still answers", async () => {
  const probe = preconditionProbe({ env: { PATH: NO_TOOLS } });
  assert.equal(await probe(["npm", "whoami"]), undefined);
});

test("a pull request lookup that cannot run is one error naming the tool and the reason", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: UNAUTH_GH },
    errors,
  });
  assert.equal(await lookup(aReference({ number: 12, text: "#12" })), undefined);
  assert.equal(await lookup(aReference({ number: 13, text: "#13" })), undefined);
  assert.equal(await lookup(aReference({ number: 14, text: "#14" })), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "gh pr view");
  assert.match(errors[0]?.message ?? "", /gh auth login/);
});

test("a pull request url is looked up in the repository it names", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([
      ["docs", join(aRepo(), "gone")],
      ["site", aRepo()],
    ]),
    env: { PATH: UNAUTH_GH },
    errors,
  });
  const url = "https://github.com/404sl/site/pull/12";
  assert.equal(await lookup(aReference({ repo: "site", url, text: url })), undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /gh auth login/);
});

test("a pull request url naming a repository nobody checked out is looked up anyway", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: UNAUTH_GH },
    errors,
  });
  const url = "https://github.com/404sl/pitwall-schema/pull/12";
  assert.equal(await lookup(aReference({ repo: "pitwall-schema", url, text: url })), undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /gh auth login/);
});

test("a bare number with more than one repository to choose from is never spawned", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([
      ["docs", aRepo()],
      ["site", aRepo()],
    ]),
    env: { PATH: UNAUTH_GH },
    errors,
  });
  assert.equal(await lookup(aReference()), undefined);
  assert.deepEqual(
    errors.map((error) => error.source),
    ["pull reference"],
    "no command ran, so nothing is blamed on the tool",
  );
});

test("a number that is not a pull request is an answer, not a collection error", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: NOTFOUND_GH },
    errors,
  });
  assert.equal(await lookup(aReference({ number: 12, text: "#12" })), undefined);
  assert.equal(await lookup(aReference({ number: 13, text: "#13" })), undefined);
  assert.equal(await lookup(aReference({ number: 14, text: "#14" })), undefined);
  assert.deepEqual(errors, []);
});

test("a pull request lookup the host refused is recorded", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: RATELIMIT_GH },
    errors,
  });
  assert.equal(await lookup(aReference()), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "gh pr view");
  assert.match(errors[0]?.message ?? "", /rate limit exceeded/);
});

test("a pull request lookup that answers something unreadable is recorded", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: GARBLED_GH },
    errors,
  });
  assert.equal(await lookup(aReference()), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "gh pr view");
});

test("a pull request lookup that never comes back is recorded", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: SLOW_GH },
    errors,
    timeoutMs: 50,
  });
  assert.equal(await lookup(aReference()), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "gh pr view");
  assert.match(errors[0]?.message ?? "", /timed out/);
});

test("the issue a merged pull request belongs to is read from its branch first", async () => {
  const lookup = aLanding();
  assert.deepEqual(await lookup(aReference({ number: 12, text: "#12" })), {
    state: "merged",
    issueId: "mw-7b1",
  });
});

test("a pull request whose branch names no issue falls back to its body", async () => {
  const lookup = aLanding();
  assert.deepEqual(await lookup(aReference({ number: 13, text: "#13" })), {
    state: "merged",
    issueId: "mw-9",
  });
});

test("a pull request that names no issue at all still reports the state it is in", async () => {
  const lookup = aLanding();
  assert.deepEqual(await lookup(aReference({ number: 14, text: "#14" })), {
    state: "merged",
    issueId: undefined,
  });
});

test("a pull request in a state nobody recognises is not an answer", async () => {
  const lookup = aLanding();
  assert.equal(await lookup(aReference({ number: 15, text: "#15" })), undefined);
});

test("nothing is attributed to an issue when the run has no id prefix to match", async () => {
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: LANDED_GH },
  });
  assert.deepEqual(await lookup(aReference({ number: 12, text: "#12" })), {
    state: "merged",
    issueId: undefined,
  });
});

function twoRepos(): Map<string, string> {
  return new Map([
    ["site", aRepo()],
    ["docs", aRepo()],
  ]);
}

test("references nowhere to place are one error per project naming them and the repositories there were", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({ repos: twoRepos(), env: { PATH: LANDED_GH }, errors });
  assert.equal(await lookup(aReference({ number: 130, text: "#130" })), undefined);
  assert.equal(await lookup(aReference({ number: 130, text: "#130" })), undefined);
  assert.equal(await lookup(aReference({ number: 131, text: "#131" })), undefined);
  assert.equal(await lookup(aReference({ number: 9, repo: "ext", text: "ext#9" })), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "pull reference");
  assert.equal(
    errors[0]?.message,
    "3 pull references could not be placed. 2 repositories are configured. #130, #131 name no repository. ext#9 names a repository that is not one of them.",
  );
});

test("a reference that cannot be placed never reads as a per-issue count of unresolved checks", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({ repos: twoRepos(), env: { PATH: LANDED_GH }, errors });
  assert.equal(await lookup(aReference({ number: 130, text: "#130" })), undefined);
  const recorded = errors[0];
  assert.notEqual(recorded, undefined);
  assert.equal(unresolvedOf(recorded?.message ?? ""), undefined);
  assert.equal(dispositionOf(recorded as CollectionError), "act");
  assert.equal(
    recorded?.message,
    "1 pull reference could not be placed. 2 repositories are configured. #130 names no repository.",
  );
});

test("a project with many unplaceable references names a few and counts the rest", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({ repos: twoRepos(), env: { PATH: LANDED_GH }, errors });
  for (const number of [130, 131, 132, 133, 134]) {
    assert.equal(await lookup(aReference({ number, text: `#${number}` })), undefined);
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /#130, #131, #132, \+2 more name no repository\./);
});

test("the repositories a named reference could not be placed in are counted, never listed", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({ repos: twoRepos(), env: { PATH: LANDED_GH }, errors });
  for (const [index, repo] of ["alpha", "beta", "gamma", "delta", "epsilon"].entries()) {
    const number = index + 1;
    assert.equal(
      await lookup(aReference({ number, repo, text: `${repo}#${number}` })),
      undefined,
    );
  }
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0]?.message,
    "5 pull references could not be placed. 2 repositories are configured. alpha#1, beta#2, gamma#3, +2 more name repositories that are not among them.",
  );
});

test("several references naming one absent repository read as one repository", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({ repos: twoRepos(), env: { PATH: LANDED_GH }, errors });
  assert.equal(await lookup(aReference({ number: 9, repo: "ext", text: "ext#9" })), undefined);
  assert.equal(await lookup(aReference({ number: 10, repo: "ext", text: "ext#10" })), undefined);
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0]?.message,
    "2 pull references could not be placed. 2 repositories are configured. ext#9, ext#10 name a repository that is not one of them.",
  );
});

test("the first failure is when a project stopped being able to place a reference", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({ repos: twoRepos(), env: { PATH: LANDED_GH }, errors });
  assert.equal(await lookup(aReference({ number: 130, text: "#130" })), undefined);
  const at = errors[0]?.at;
  await new Promise((resume) => setTimeout(resume, 5));
  assert.equal(await lookup(aReference({ number: 131, text: "#131" })), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.at, at);
});

test("a reference a single repository can answer for is placed there and records nothing", async () => {
  const errors: CollectionError[] = [];
  const lookup = pullLookup({
    repos: new Map([["site", aRepo()]]),
    env: { PATH: LANDED_GH },
    errors,
  });
  assert.notEqual(await lookup(aReference({ number: 12, text: "#12" })), undefined);
  assert.deepEqual(errors, []);
});
