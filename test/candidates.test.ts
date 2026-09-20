import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Project, type Candidate } from "@404sl/pitwall-schema";
import { readWorkspace, WORKSPACE_FILE } from "../src/autofix.ts";
import { LIST_LIMIT, linkedKeys, listArgs, readCandidates, signalOf } from "../src/candidates.ts";
import { nullGlobalGitConfig, spawnGit } from "./support/git.js";

nullGlobalGitConfig();

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gh");
const RECORDED = join(FIXTURES, "recorded");

const HTTPS_REMOTE = "https://github.com/acme/site.git";
const SSH_REMOTE = "git@github.com:acme/site.git";

const LISTING =
  "gh issue list --repo acme/site --state open --limit 200 --json number,title,url,author,createdAt";

function git(dir: string, ...args: string[]): void {
  const ran = spawnGit(args, { cwd: dir });
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

function project(remotes: Record<string, string | undefined> = { site: HTTPS_REMOTE }): Project {
  const root = mkdtempSync(join(tmpdir(), "pitwall-candidates-"));
  const repos: Record<string, { path: string }> = {};
  for (const [name, remote] of Object.entries(remotes)) {
    checkout(root, name, remote);
    repos[name] = { path: name };
  }
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ idPrefix: "mw", repos }));
  return readWorkspace(root);
}

function env(bin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${join(FIXTURES, bin)}:/usr/bin:/bin`, GH_OUTPUT: RECORDED, ...extra };
}

async function collected(
  linked: readonly string[] = [],
  bin = "ok",
  extra: Record<string, string> = {},
  remotes?: Record<string, string | undefined>,
) {
  return readCandidates(project(remotes), { env: env(bin, extra), linked });
}

function numbers(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.ref);
}

test("the listing asks for open issues only, with the fields a candidate carries", () => {
  assert.equal(["gh", ...listArgs("acme/site")].join(" "), LISTING);
});

test("every open issue of a repo is a candidate carrying its author's login and when it was opened", async () => {
  const read = await collected();
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.signals, [
    { kind: "github", name: "acme/site", location: "https://github.com/acme/site/issues" },
  ]);
  assert.deepEqual(read.candidates, [
    {
      source: "acme/site",
      ref: "https://github.com/acme/site/issues/7",
      title: "Snapshot reports zero lanes when the slot registry is missing",
      repo: "site",
      url: "https://github.com/acme/site/issues/7",
      author: "elik-ru",
      createdAt: "2026-09-01T08:15:00Z",
    },
    {
      source: "acme/site",
      ref: "https://github.com/acme/site/issues/8",
      title: "Console shows a stale board after the tracker moves",
      repo: "site",
      url: "https://github.com/acme/site/issues/8",
      author: "stranger",
      createdAt: "2026-09-05T17:40:00Z",
    },
    {
      source: "acme/site",
      ref: "https://github.com/acme/site/issues/9",
      title: "Bump actions/checkout from 4 to 5",
      repo: "site",
      url: "https://github.com/acme/site/issues/9",
      author: "app/dependabot",
      createdAt: "2026-09-07T03:00:00Z",
    },
  ]);
  for (const candidate of read.candidates) {
    assert.ok(!("classification" in candidate), "a candidate is not shaped like an issue");
  }
});

test("a candidate's source is the name of a signal the collector declared", async () => {
  const read = await collected();
  const declared = new Set(read.signals.map((signal) => signal.name));
  for (const candidate of read.candidates) {
    assert.ok(declared.has(candidate.source), `${candidate.ref} cites a signal nobody declared`);
  }
  assert.deepEqual(signalOf("acme/site"), read.signals[0]);
});

test("an issue a tracker item already links by external-ref is not a candidate", async () => {
  const read = await collected(["https://github.com/acme/site/issues/8"]);
  assert.deepEqual(numbers(read.candidates), [
    "https://github.com/acme/site/issues/7",
    "https://github.com/acme/site/issues/9",
  ]);
});

test("a link matches however the reference was written, and a foreign reference excludes nothing", async () => {
  const read = await collected([
    "https://github.com/Acme/Site/issues/7?ref=console#issue",
    " https://github.com/acme/site/issues/9 ",
    "https://session-replay.com/replays/e5QfEEjBkaPuvxwGyjn2vw",
    "https://github.com/acme/other/issues/8",
    "not a reference at all",
  ]);
  assert.deepEqual(numbers(read.candidates), ["https://github.com/acme/site/issues/8"]);
  assert.deepEqual(
    [...linkedKeys(["https://github.com/Acme/Site/issues/7#x", "nope"])],
    ["acme/site#7"],
  );
});

test("the same issue linked twice over is still just excluded", async () => {
  const read = await collected([
    "https://github.com/acme/site/issues/8",
    "https://github.com/acme/site/issues/8",
  ]);
  assert.deepEqual(numbers(read.candidates), [
    "https://github.com/acme/site/issues/7",
    "https://github.com/acme/site/issues/9",
  ]);
});

test("gh that cannot authenticate is an error naming the command, not an empty list", async () => {
  const read = await collected([], "unauth");
  assert.deepEqual(read.candidates, []);
  assert.equal(read.signals.length, 1);
  assert.equal(read.errors.length, 1);
  assert.equal(read.errors[0]?.source, LISTING);
  assert.match(read.errors[0]?.message ?? "", /gh auth login/);
});

test("gh that is not installed is an error naming the command, not an empty list", async () => {
  const read = await readCandidates(project(), {
    env: { PATH: join(FIXTURES, "missing"), GH_OUTPUT: RECORDED },
    linked: [],
  });
  assert.deepEqual(read.candidates, []);
  assert.equal(read.errors.length, 1);
  assert.equal(read.errors[0]?.source, LISTING);
  assert.match(read.errors[0]?.message ?? "", /ENOENT/);
});

test("output that is not a list of issues is an error, not an empty list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-candidates-garbage-"));
  writeFileSync(join(dir, "issues.json"), '{"message": "Not Found"}');
  const read = await collected([], "ok", { GH_OUTPUT: dir });
  assert.deepEqual(read.candidates, []);
  assert.equal(read.errors.length, 1);
  assert.equal(read.errors[0]?.source, LISTING);
  assert.match(read.errors[0]?.message ?? "", /not an array of issues/);
});

test("a listing that fills the limit says so, because anything past it was not read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-candidates-full-"));
  writeFileSync(
    join(dir, "issues.json"),
    JSON.stringify(
      Array.from({ length: LIST_LIMIT }, (_unused, index) => ({
        number: index + 1,
        title: `Issue ${index + 1}`,
        url: `https://github.com/acme/site/issues/${index + 1}`,
        author: { login: "someone" },
        createdAt: "2026-09-01T00:00:00Z",
      })),
    ),
  );
  const read = await collected([], "ok", { GH_OUTPUT: dir });
  assert.equal(read.candidates.length, LIST_LIMIT);
  assert.equal(read.errors.length, 1);
  assert.equal(read.errors[0]?.source, LISTING);
  assert.match(read.errors[0]?.message ?? "", new RegExp(`${LIST_LIMIT} issue limit`));
});

test("an author the host did not name is absent, never a placeholder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-candidates-ghost-"));
  writeFileSync(
    join(dir, "issues.json"),
    JSON.stringify([
      { number: 3, title: "Untitled by nobody", url: "https://github.com/acme/site/issues/3" },
      { number: "4", title: "Not a number" },
    ]),
  );
  const read = await collected([], "ok", { GH_OUTPUT: dir });
  assert.deepEqual(read.errors, []);
  assert.deepEqual(JSON.parse(JSON.stringify(read.candidates)), [
    {
      source: "acme/site",
      ref: "https://github.com/acme/site/issues/3",
      title: "Untitled by nobody",
      repo: "site",
      url: "https://github.com/acme/site/issues/3",
    },
  ]);
});

test("a tracker that could not be read leaves the issues unread and says why", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "pitwall-candidates-log-")), "asked");
  const read = await readCandidates(project(), { env: env("ok", { GH_LOG: log }) });
  assert.deepEqual(read.candidates, []);
  assert.ok(!existsSync(log), "gh was asked for issues nothing could place");
  assert.deepEqual(read.signals, [signalOf("acme/site")]);
  assert.equal(read.errors.length, 1);
  assert.equal(read.errors[0]?.source, "acme/site");
  assert.match(read.errors[0]?.message ?? "", /tracker could not be/);
});

test("a repo with no remote and a repo sharing an origin are each read once at most", async () => {
  const read = await collected([], "ok", {}, {
    site: HTTPS_REMOTE,
    mirror: SSH_REMOTE,
    local: undefined,
  });
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.signals, [signalOf("acme/site")]);
  assert.equal(read.candidates.length, 3);
  assert.ok(read.candidates.every((candidate) => candidate.repo === "site"));
});

test("a repo hosted somewhere other than github.com is not read as a GitHub signal", async () => {
  const read = await collected([], "ok", {}, { site: "git@git.example.com:acme/site.git" });
  assert.deepEqual(read, { signals: [], candidates: [], errors: [] });
});

test("a project with no repos declares no signals and finds nothing", async () => {
  const read = await collected([], "ok", {}, {});
  assert.deepEqual(read, { signals: [], candidates: [], errors: [] });
});

test("what the collector returns is accepted by the contract as it stands", async () => {
  const read = await collected();
  const parsed = Project.parse({
    id: "a",
    name: "a",
    root: "/a",
    authority: { kind: "beads" },
    metrics: {},
    signals: read.signals,
    candidates: read.candidates,
  });
  assert.equal(parsed.candidates.length, 3);
  assert.deepEqual(parsed.issues, []);
});
