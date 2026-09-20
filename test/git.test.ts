import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspace, WORKSPACE_FILE } from "../src/autofix.ts";
import { defaultBranchOf } from "../src/git.ts";
import { nullGlobalGitConfig, spawnGit } from "./support/git.js";

nullGlobalGitConfig();

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "pitwall-git-"));
}

function git(dir: string, ...args: string[]): void {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, ran.stderr);
}

function checkout(root: string, name: string, branch?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  if (branch !== undefined) {
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  }
  return dir;
}

function describe(root: string, ...names: string[]): void {
  const repos = Object.fromEntries(names.map((name) => [name, { path: name }]));
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ idPrefix: "gw", repos }));
}

function describeWith(root: string, repos: Record<string, Record<string, unknown>>): void {
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ idPrefix: "gw", repos }));
}

test("a checkout whose origin default is master reports master, not main", () => {
  const root = workspace();
  const dir = checkout(root, "site", "master");
  assert.equal(defaultBranchOf(dir), "master");

  describe(root, "site");
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, "master");
  assert.deepEqual(project.errors, []);
});

test("a branch name carrying a slash survives the remote prefix being stripped", () => {
  const dir = checkout(workspace(), "site", "release/2026");
  assert.equal(defaultBranchOf(dir), "release/2026");
});

test("a checkout with no origin reports nothing rather than a branch it did not read", () => {
  const root = workspace();
  assert.equal(defaultBranchOf(checkout(root, "site")), undefined);

  describe(root, "site");
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, undefined);
  assert.deepEqual(project.errors, []);
});

test("a checkout with an origin but no origin/HEAD leaves the branch absent rather than guessing", () => {
  const root = workspace();
  const dir = checkout(root, "site");
  git(dir, "remote", "add", "origin", "https://github.com/acme/site.git");
  assert.equal(defaultBranchOf(dir), undefined);

  describe(root, "site");
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, undefined);
  assert.equal("defaultBranch" in (project.repos[0] ?? {}), false);
  assert.deepEqual(project.errors, []);
});

test("a directory that is not a checkout is not answered by the repository above it", () => {
  const root = workspace();
  checkout(root, ".", "master");
  const plain = join(root, "site");
  mkdirSync(plain, { recursive: true });
  assert.equal(defaultBranchOf(plain), undefined);
});

test("a repo with no checkout on disk does not throw and records no error", () => {
  const root = workspace();
  describe(root, "site");
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, undefined);
  assert.deepEqual(project.errors, []);
});

test("a configured defaultBranch wins over what the clone's origin/HEAD says", () => {
  const root = workspace();
  const dir = checkout(root, "site", "master");
  assert.equal(defaultBranchOf(dir), "master");

  describeWith(root, { site: { path: "site", defaultBranch: "main" } });
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, "main");
  assert.deepEqual(project.errors, []);
});

test("a configured defaultBranch needs no checkout on disk to be reported", () => {
  const root = workspace();
  describeWith(root, { site: { path: "site", defaultBranch: "release/2026" } });
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, "release/2026");
  assert.deepEqual(project.errors, []);
});

test("a repo with no defaultBranch configured still reads it from origin/HEAD", () => {
  const root = workspace();
  checkout(root, "site", "release/2026");
  describeWith(root, { site: { path: "site" } });
  const project = readWorkspace(root);
  assert.equal(project.repos[0]?.defaultBranch, "release/2026");
  assert.deepEqual(project.errors, []);
});

test("a defaultBranch that is not a branch name is a CollectionError, not a branch", () => {
  const root = workspace();
  checkout(root, "site", "master");
  describeWith(root, { site: { path: "site", defaultBranch: 7 } });
  const project = readWorkspace(root);
  assert.deepEqual(project.repos, []);
  assert.equal(project.errors.length, 1);
  assert.match(project.errors[0]?.message ?? "", /repo site defaultBranch/);
});
