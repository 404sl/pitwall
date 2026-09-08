import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PullRequest, type Project } from "@404sl/pitwall-schema";
import { readWorkspace, WORKSPACE_FILE } from "../src/autofix.ts";
import { remoteSlugOf, slugOf } from "../src/git.ts";
import { issueMatcher, readPipeline, rollupChecks } from "../src/pipeline.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gh");
const RECORDED = join(FIXTURES, "recorded");

const HTTPS_REMOTE = "https://github.com/acme/site.git";
const SSH_REMOTE = "git@github.com:acme/site.git";

function git(dir: string, ...args: string[]): void {
  const ran = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
}

function checkout(root: string, name: string, remote?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  if (remote !== undefined) {
    git(dir, "remote", "add", "origin", remote);
  }
  return dir;
}

function project(remote?: string, idPrefix = "mw"): Project {
  const root = mkdtempSync(join(tmpdir(), "pitwall-pipeline-"));
  checkout(root, "site", remote);
  writeFileSync(
    join(root, WORKSPACE_FILE),
    JSON.stringify({ idPrefix, repos: { site: { path: "site" } } }),
  );
  return readWorkspace(root);
}

function env(bin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${join(FIXTURES, bin)}:/usr/bin:/bin`, GH_OUTPUT: RECORDED, ...extra };
}

const KNOWN = new Set(["mw-7", "mw-12", "mw-1.1"]);

async function collected(remote = HTTPS_REMOTE, bin = "ok", extra: Record<string, string> = {}) {
  return readPipeline(project(remote), { env: env(bin, extra), knownIds: KNOWN });
}

function byNumber(pipeline: readonly PullRequest[]): Map<number, PullRequest> {
  return new Map(pipeline.map((pull) => [pull.number, pull]));
}

test("a slug is read out of the remote in both the https and the ssh form", () => {
  assert.equal(slugOf(HTTPS_REMOTE), "acme/site");
  assert.equal(slugOf(SSH_REMOTE), "acme/site");
  assert.equal(slugOf("https://github.com/acme/site"), "acme/site");
  assert.equal(slugOf("ssh://git@github.com/acme/site.git"), "acme/site");
  assert.equal(slugOf("https://user@github.com/acme/site.git/"), "acme/site");
  assert.equal(slugOf("ssh://git@github.com:22/acme/site.git"), "acme/site");
  assert.equal(slugOf("https://github.com/12345/site.git"), "12345/site");
});

test("a remote on somebody else's host keeps the host rather than pointing at github", () => {
  assert.equal(slugOf("git@git.example.com:acme/site.git"), "git.example.com/acme/site");
  assert.equal(slugOf("https://git.example.com/acme/site.git"), "git.example.com/acme/site");
});

test("a remote that is not a repository address yields no slug", () => {
  assert.equal(slugOf(""), undefined);
  assert.equal(slugOf("/Users/someone/work/site"), undefined);
  assert.equal(slugOf("https://github.com/acme"), undefined);
});

test("the checkout is asked for its remote rather than the configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "pitwall-slug-"));
  assert.equal(remoteSlugOf(checkout(root, "https", HTTPS_REMOTE)), "acme/site");
  assert.equal(remoteSlugOf(checkout(root, "ssh", SSH_REMOTE)), "acme/site");
  assert.equal(remoteSlugOf(checkout(root, "bare")), undefined);
  assert.equal(remoteSlugOf(join(root, "absent")), undefined);
});

test("every open pull request reported is one the contract accepts", async () => {
  const read = await collected();
  assert.deepEqual(read.errors, []);
  assert.deepEqual(
    read.pipeline.map((pull) => pull.number),
    [101, 102, 103, 104, 105],
  );
  for (const pull of read.pipeline) {
    assert.doesNotThrow(() => PullRequest.parse(pull));
    assert.equal(pull.repo, "site");
  }
  assert.deepEqual(byNumber(read.pipeline).get(101)?.labels, ["lane-verified"]);
  assert.equal(
    byNumber(read.pipeline).get(101)?.url,
    "https://github.com/acme/site/pull/101",
  );
});

test("the four check states are read apart and none is not green", async () => {
  const pulls = byNumber((await collected()).pipeline);
  assert.equal(pulls.get(101)?.checks, "green");
  assert.equal(pulls.get(102)?.checks, "red");
  assert.equal(pulls.get(103)?.checks, "pending");
  assert.equal(pulls.get(104)?.checks, "none");
  assert.notEqual(pulls.get(104)?.checks, pulls.get(101)?.checks);
});

test("a check that failed outranks one that is still running", () => {
  assert.equal(
    rollupChecks([
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
    ]),
    "red",
  );
  assert.equal(rollupChecks([{ __typename: "StatusContext", state: "EXPECTED" }]), "pending");
  assert.equal(rollupChecks([{ __typename: "CheckRun", status: "COMPLETED" }]), "pending");
  assert.equal(rollupChecks(undefined), "none");
});

test("a pull request is linked to its issue by its branch name or by its body", async () => {
  const pulls = byNumber((await collected()).pipeline);
  assert.equal(pulls.get(101)?.issueId, "mw-12");
  assert.equal(pulls.get(102)?.issueId, "mw-7");
  assert.equal(pulls.get(103)?.issueId, undefined);
  assert.equal(pulls.get(104)?.issueId, undefined);
});

test("a body that names a sibling repository is not read as an issue the tracker never had", async () => {
  const pulls = byNumber((await collected()).pipeline);
  assert.equal(pulls.get(105)?.issueId, undefined);
});

test("linkage takes the project's prefix and not a word that merely ends in it", () => {
  const match = issueMatcher("mw", KNOWN);
  assert.equal(match("autofix/mw-1.1"), "mw-1.1");
  assert.equal(match("teamw-12 is not an id"), undefined);
  assert.equal(match("fix-mw-12"), "mw-12");
  assert.equal(match("nothing here"), undefined);
  assert.equal(issueMatcher(undefined, KNOWN)("autofix/mw-12"), undefined);
});

test("linkage names an issue the tracker knows or none at all", () => {
  const match = issueMatcher("mw", KNOWN);
  assert.equal(match("Bump mw-schema to 0.3.1"), undefined);
  assert.equal(match("https://github.com/acme/mw-schema/pull/9"), undefined);
  assert.equal(match("Bump mw-schema, which unblocks mw-7"), "mw-7");
  assert.equal(issueMatcher("mw", new Set())("autofix/mw-12"), undefined);
});

test("a project with no idPrefix links nothing rather than guessing", async () => {
  const read = await readPipeline(project(HTTPS_REMOTE, ""), {
    env: env("ok"),
    knownIds: KNOWN,
  });
  assert.deepEqual(
    read.pipeline.map((pull) => pull.issueId),
    [undefined, undefined, undefined, undefined, undefined],
  );
});

test("the command carries the slug derived from the remote", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "pitwall-ghlog-")), "asked");
  await collected(SSH_REMOTE, "ok", { GH_LOG: log });
  const asked = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(
    asked[0],
    "pr list --repo acme/site --state open --limit 200 --json number,title,labels,headRefName,url",
  );
  assert.equal(asked[1], "pr view 101 --repo acme/site --json statusCheckRollup,body");
  assert.equal(asked.length, 6);
});

test("gh that is not installed is an error naming the command, not an empty pipeline", async () => {
  const read = await readPipeline(project(HTTPS_REMOTE), {
    env: { PATH: join(FIXTURES, "missing"), GH_OUTPUT: RECORDED },
    knownIds: KNOWN,
  });
  assert.deepEqual(read.pipeline, []);
  assert.equal(read.errors.length, 1);
  assert.equal(
    read.errors[0]?.source,
    "gh pr list --repo acme/site --state open --limit 200 --json number,title,labels,headRefName,url",
  );
  assert.match(read.errors[0]?.message ?? "", /gh pr list --repo acme\/site/);
  assert.match(read.errors[0]?.message ?? "", /ENOENT/);
});

test("gh that cannot authenticate reports what it said rather than reporting nothing open", async () => {
  const read = await collected(HTTPS_REMOTE, "unauth");
  assert.deepEqual(read.pipeline, []);
  assert.equal(read.errors.length, 1);
  assert.match(read.errors[0]?.source ?? "", /^gh pr list --repo acme\/site/);
  assert.match(read.errors[0]?.message ?? "", /gh auth login/);
});

test("a repo with no remote to name is passed over without inventing a failure", async () => {
  const read = await readPipeline(project(), { env: env("ok"), knownIds: KNOWN });
  assert.deepEqual(read.pipeline, []);
  assert.deepEqual(read.errors, []);
});
