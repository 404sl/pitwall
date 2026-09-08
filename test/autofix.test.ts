import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Project } from "@404sl/pitwall-schema";
import { readWorkspace } from "../src/autofix.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("a multi-repo workspace becomes a Project the contract accepts", () => {
  const project = readWorkspace(join(FIXTURES, "multi"));
  assert.doesNotThrow(() => Project.parse(project));
  assert.equal(project.id, "multi");
  assert.equal(project.name, "multi");
  assert.equal(project.root, join(FIXTURES, "multi"));
  assert.equal(project.authority.kind, "beads");
  assert.equal(project.authority.idPrefix, "mw");
  assert.deepEqual(project.errors, []);
});

test("the root is the directory holding the file, not the root field inside it", () => {
  const project = readWorkspace(join(FIXTURES, "multi"));
  assert.equal(project.root, join(FIXTURES, "multi"));
  assert.notEqual(project.root, "/nowhere/that/exists");
});

test("keys beginning with an underscore are documentation and are not repos", () => {
  const project = readWorkspace(join(FIXTURES, "multi"));
  assert.deepEqual(
    project.repos.map((repo) => repo.name),
    ["site", "extension", "docs"],
  );
});

test("a non-empty deploy array infers deployable and its absence infers library", () => {
  const project = readWorkspace(join(FIXTURES, "multi"));
  const kinds = Object.fromEntries(project.repos.map((repo) => [repo.name, repo.kind]));
  assert.deepEqual(kinds, { site: "deployable", extension: "library", docs: "library" });
});

test("repo paths resolve against the workspace root, including a single-repo dot", () => {
  const multi = readWorkspace(join(FIXTURES, "multi"));
  assert.equal(multi.repos[0]?.path, join(FIXTURES, "multi", "site"));

  const single = readWorkspace(join(FIXTURES, "single"));
  assert.equal(single.repos.length, 1);
  assert.equal(single.repos[0]?.path, join(FIXTURES, "single"));
  assert.equal(single.repos[0]?.kind, "deployable");
  assert.equal(single.authority.idPrefix, "one");
});

test("a workspace where nothing deploys yields only libraries", () => {
  const project = readWorkspace(join(FIXTURES, "plain"));
  assert.deepEqual(
    project.repos.map((repo) => [repo.name, repo.kind]),
    [
      ["site", "library"],
      ["integration", "library"],
    ],
  );
});

test("a root that does not exist is a CollectionError, not a throw", () => {
  const missing = join(FIXTURES, "no-such-workspace");
  const project = readWorkspace(missing);
  assert.doesNotThrow(() => Project.parse(project));
  assert.equal(project.root, missing);
  assert.deepEqual(project.repos, []);
  assert.equal(project.errors.length, 1);
  assert.equal(project.errors[0]?.source, join(missing, ".autofix.json"));
});

test("a root holding no .autofix.json is a CollectionError", () => {
  const project = readWorkspace(join(FIXTURES, "empty"));
  assert.equal(project.errors.length, 1);
  assert.match(project.errors[0]?.message ?? "", /ENOENT/);
});

test("a file that cannot be read is a CollectionError", () => {
  const project = readWorkspace(join(FIXTURES, "unreadable"));
  assert.equal(project.repos.length, 0);
  assert.equal(project.errors.length, 1);
  assert.equal(project.errors[0]?.source, join(FIXTURES, "unreadable", ".autofix.json"));
});

test("malformed JSON is a CollectionError", () => {
  const project = readWorkspace(join(FIXTURES, "broken"));
  assert.equal(project.errors.length, 1);
  assert.match(project.errors[0]?.message ?? "", /JSON/);
});

test("an error carries a timestamp the contract accepts", () => {
  const project = readWorkspace(join(FIXTURES, "broken"));
  assert.doesNotThrow(() => Project.parse(project));
  assert.match(project.errors[0]?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("a relative root is resolved", () => {
  const project = readWorkspace(join(FIXTURES, "multi", "..", "single"));
  assert.equal(project.root, resolve(FIXTURES, "single"));
});
