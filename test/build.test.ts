import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildCheck, readStamp, type BuildStamp } from "../src/build.ts";
import { nullGlobalGitConfig, spawnGit } from "./support/git.js";

nullGlobalGitConfig();

const STAMPER = fileURLToPath(new URL("../scripts/stamp-build.mjs", import.meta.url));
const ABSENT = "0123456789abcdef0123456789abcdef01234567";

function git(dir: string, ...args: string[]): string {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return (ran.stdout ?? "").trim();
}

function commit(dir: string, name: string): string {
  writeFileSync(join(dir, name), `${name}\n`);
  git(dir, "add", name);
  git(
    dir,
    "-c",
    "user.name=Pitwall Test",
    "-c",
    "user.email=test@pitwall.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    name,
  );
  return git(dir, "rev-parse", "HEAD");
}

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-build-"));
  git(dir, "init", "--quiet");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/master");
  return dir;
}

function stampFile(dir: string, stamp: unknown): string {
  const path = join(dir, "build.json");
  writeFileSync(path, typeof stamp === "string" ? stamp : JSON.stringify(stamp));
  return path;
}

const AT = "2026-09-08T20:47:00.000Z";

test("a console built from the commit the checkout is on reports its build as current", () => {
  const repo = checkout();
  const head = commit(repo, "one");
  const check = createBuildCheck({ repo, stamp: { commit: head, at: AT } });

  assert.deepEqual(check.state(), {
    build: { commit: head, at: AT },
    checkout: { branch: "master", head, ahead: 0 },
    buildCheck: "current",
  });
});

test("a console built before the checkout moved says how far behind it is, naming both commits", () => {
  const repo = checkout();
  const built = commit(repo, "one");
  commit(repo, "two");
  const head = commit(repo, "three");
  const check = createBuildCheck({ repo, stamp: { commit: built, at: AT } });

  assert.deepEqual(check.state(), {
    build: { commit: built, at: AT },
    checkout: { branch: "master", head, ahead: 2 },
    buildCheck: "behind",
  });
});

test("a build with nothing stamped into it is unknown, never current", () => {
  const repo = checkout();
  commit(repo, "one");
  const check = createBuildCheck({ repo, stampFile: join(repo, "no-such-stamp.json") });

  assert.deepEqual(check.state(), { buildCheck: "unknown", unknownBecause: { kind: "no-stamp" } });
});

test("a commit the checkout has never heard of is unknown, not behind", () => {
  const repo = checkout();
  commit(repo, "one");
  const head = git(repo, "rev-parse", "HEAD");
  const check = createBuildCheck({ repo, stamp: { commit: ABSENT } });

  assert.deepEqual(check.state(), {
    build: { commit: ABSENT },
    checkout: { branch: "master", head },
    buildCheck: "unknown",
    unknownBecause: { kind: "diverged" },
  });
});

test("a checkout that cannot be read names the reason and claims nothing", () => {
  const repo = mkdtempSync(join(tmpdir(), "pitwall-build-"));
  writeFileSync(join(repo, ".git"), "gitdir: /pitwall/no/such/checkout\n");
  const check = createBuildCheck({ repo, stamp: { commit: ABSENT, at: AT } });
  const report = check.state();

  assert.equal(report.buildCheck, "unknown");
  assert.equal(report.unknownBecause?.kind, "checkout");
  assert.notEqual(report.unknownBecause?.kind === "checkout" ? report.unknownBecause.message : "", "");
  assert.deepEqual(report.build, { commit: ABSENT, at: AT });
});

test("an installed copy with no checkout above it is reported as such, not as current", () => {
  const repo = mkdtempSync(join(tmpdir(), "pitwall-build-"));
  const check = createBuildCheck({ repo, stamp: { commit: ABSENT, at: AT } });

  assert.deepEqual(check.state(), { build: { commit: ABSENT, at: AT }, buildCheck: "no-checkout" });
});

test("the checkout is re-read on an interval - commits keep landing while the process lives", () => {
  const repo = checkout();
  const built = commit(repo, "one");
  let now = 1_000;
  const check = createBuildCheck({ repo, stamp: { commit: built }, everyMs: 60_000, now: () => now });

  assert.equal(check.state().buildCheck, "current");
  commit(repo, "two");
  assert.equal(check.state().buildCheck, "current");

  now += 60_000;
  const moved = check.state();
  assert.equal(moved.buildCheck, "behind");
  assert.equal(moved.checkout?.ahead, 1);
});

test("the build stamp is the one the process was loaded with, not whatever the stamp file says now", () => {
  const repo = checkout();
  const built = commit(repo, "one");
  const file = stampFile(repo, { commit: built, at: AT });
  const check = createBuildCheck({ repo, stampFile: file });
  assert.equal(check.state().buildCheck, "current");

  const moved = commit(repo, "two");
  writeFileSync(file, JSON.stringify({ commit: moved, at: AT }));
  check.refresh();
  const report = check.state();

  assert.equal(report.buildCheck, "behind");
  assert.deepEqual(report.build, { commit: built, at: AT });
});

test("a stamp that is not a commit is no stamp at all", () => {
  const repo = checkout();
  commit(repo, "one");
  assert.equal(readStamp(stampFile(repo, "not json")), undefined);
  assert.equal(readStamp(stampFile(repo, { commit: "HEAD" })), undefined);
  assert.equal(readStamp(stampFile(repo, { at: AT })), undefined);
  assert.equal(readStamp(join(repo, "nothing-here.json")), undefined);
  assert.deepEqual(readStamp(stampFile(repo, { commit: ABSENT, at: 17 })), { commit: ABSENT });
});

test("the build step stamps the commit the package was built from", () => {
  const repo = checkout();
  const head = commit(repo, "one");
  const out = join(mkdtempSync(join(tmpdir(), "pitwall-stamp-")), "dist", "build.json");
  execFileSync(process.execPath, [STAMPER, `--repo=${repo}`, `--out=${out}`], { encoding: "utf8" });

  const stamp = readStamp(out) as BuildStamp;
  assert.equal(stamp.commit, head);
  assert.ok(!Number.isNaN(Date.parse(stamp.at ?? "")), "the stamp records when the build was made");
});

test("a build made where there is no checkout stamps nothing rather than guessing", () => {
  const repo = mkdtempSync(join(tmpdir(), "pitwall-build-"));
  const out = join(mkdtempSync(join(tmpdir(), "pitwall-stamp-")), "dist", "build.json");
  const said = execFileSync(process.execPath, [STAMPER, `--repo=${repo}`, `--out=${out}`], { encoding: "utf8" });

  assert.match(said, /no commit to stamp/);
  assert.equal(readStamp(out), undefined);
});

test("a stamp file the build never wrote leaves the report unknown", () => {
  const repo = checkout();
  commit(repo, "one");
  const file = stampFile(repo, { commit: "not-a-sha" });

  assert.deepEqual(createBuildCheck({ repo, stampFile: file }).state(), {
    buildCheck: "unknown",
    unknownBecause: { kind: "no-stamp" },
  });
});
