import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CollectionError } from "@404sl/pitwall-schema";
import { preconditionProbe, pullLookup } from "../src/probes.ts";
import type { PullReference } from "../src/staleness.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NO_TOOLS = join(FIXTURES, "gh", "missing");
const UNAUTH_GH = `${join(FIXTURES, "gh", "unauth")}:/usr/bin:/bin`;

function aReference(over: Partial<PullReference> = {}): PullReference {
  return { number: 12, repo: undefined, url: undefined, text: "#12", ...over };
}

function aRepo(): string {
  return mkdtempSync(join(tmpdir(), "pitwall-probe-"));
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
  assert.deepEqual(errors, []);
});
