import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Project } from "@404sl/pitwall-schema";
import { readWorkspace, workspaceFile } from "../src/autofix.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NAMES = join(FIXTURES, "names");
const NO_REGISTRY = { lockRoot: mkdtempSync(join(tmpdir(), "pitwall-no-registry-")) };

test("a multi-repo workspace becomes a Project the contract accepts", () => {
  const project = readWorkspace(join(FIXTURES, "multi"), NO_REGISTRY);
  assert.doesNotThrow(() => Project.parse(project));
  assert.equal(project.id, "multi");
  assert.equal(project.name, "multi");
  assert.equal(project.root, join(FIXTURES, "multi"));
  assert.equal(project.authority.kind, "beads");
  assert.equal(project.authority.idPrefix, "mw");
  assert.deepEqual(project.errors, []);
});

test("the root is the directory holding the file, not the root field inside it", () => {
  const project = readWorkspace(join(FIXTURES, "multi"), NO_REGISTRY);
  assert.equal(project.root, join(FIXTURES, "multi"));
  assert.notEqual(project.root, "/nowhere/that/exists");
});

test("keys beginning with an underscore are documentation and are not repos", () => {
  const project = readWorkspace(join(FIXTURES, "multi"), NO_REGISTRY);
  assert.deepEqual(
    project.repos.map((repo) => repo.name),
    ["site", "extension", "docs"],
  );
});

test("a non-empty deploy array infers deployable and its absence infers library", () => {
  const project = readWorkspace(join(FIXTURES, "multi"), NO_REGISTRY);
  const kinds = Object.fromEntries(project.repos.map((repo) => [repo.name, repo.kind]));
  assert.deepEqual(kinds, { site: "deployable", extension: "library", docs: "library" });
});

test("repo paths resolve against the workspace root, including a single-repo dot", () => {
  const multi = readWorkspace(join(FIXTURES, "multi"), NO_REGISTRY);
  assert.equal(multi.repos[0]?.path, join(FIXTURES, "multi", "site"));

  const single = readWorkspace(join(FIXTURES, "single"), NO_REGISTRY);
  assert.equal(single.repos.length, 1);
  assert.equal(single.repos[0]?.path, join(FIXTURES, "single"));
  assert.equal(single.repos[0]?.kind, "deployable");
  assert.equal(single.authority.idPrefix, "one");
});

test("a workspace where nothing deploys yields only libraries", () => {
  const project = readWorkspace(join(FIXTURES, "plain"), NO_REGISTRY);
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
  const project = readWorkspace(missing, NO_REGISTRY);
  assert.doesNotThrow(() => Project.parse(project));
  assert.equal(project.root, missing);
  assert.deepEqual(project.repos, []);
  assert.equal(project.errors.length, 1);
  assert.equal(project.errors[0]?.source, join(missing, ".pitwall.json"));
});

test("a root holding neither workspace file is a CollectionError", () => {
  const project = readWorkspace(join(FIXTURES, "empty"), NO_REGISTRY);
  assert.equal(project.errors.length, 1);
  assert.match(project.errors[0]?.message ?? "", /ENOENT/);
});

test("a file that cannot be read is a CollectionError", () => {
  const project = readWorkspace(join(FIXTURES, "unreadable"), NO_REGISTRY);
  assert.equal(project.repos.length, 0);
  assert.equal(project.errors.length, 1);
  assert.equal(project.errors[0]?.source, join(FIXTURES, "unreadable", ".autofix.json"));
});

test("malformed JSON is a CollectionError", () => {
  const project = readWorkspace(join(FIXTURES, "broken"), NO_REGISTRY);
  assert.equal(project.errors.length, 1);
  assert.match(project.errors[0]?.message ?? "", /JSON/);
});

test("an error carries a timestamp the contract accepts", () => {
  const project = readWorkspace(join(FIXTURES, "broken"), NO_REGISTRY);
  assert.doesNotThrow(() => Project.parse(project));
  assert.match(project.errors[0]?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("a relative root is resolved", () => {
  const project = readWorkspace(join(FIXTURES, "multi", "..", "single"), NO_REGISTRY);
  assert.equal(project.root, resolve(FIXTURES, "single"));
});

test("a workspace named .pitwall.json is read", () => {
  const project = readWorkspace(join(NAMES, "newonly"), NO_REGISTRY);
  assert.deepEqual(project.errors, []);
  assert.equal(project.authority.idPrefix, "newonly");
});

test("a workspace still named .autofix.json is read", () => {
  const project = readWorkspace(join(NAMES, "oldonly"), NO_REGISTRY);
  assert.deepEqual(project.errors, []);
  assert.equal(project.authority.idPrefix, "oldonly");
});

test("both names in one directory is a migration, not an error, and the new one wins", () => {
  const project = readWorkspace(join(NAMES, "both"), NO_REGISTRY);
  assert.deepEqual(project.errors, []);
  assert.equal(project.authority.idPrefix, "both-new");
  assert.deepEqual(
    project.repos.map((repo) => repo.name),
    ["site"],
  );
});

test("the nearest directory wins, so a parent's .pitwall.json loses to a nearer .autofix.json", () => {
  assert.equal(workspaceFile(NAMES)?.name, ".pitwall.json");
  assert.equal(workspaceFile(join(NAMES, "oldonly"))?.name, ".autofix.json");
  const project = readWorkspace(join(NAMES, "oldonly"), NO_REGISTRY);
  assert.equal(project.authority.idPrefix, "oldonly");
});

test("the filename actually used is reported, so a reader can say which one is live", () => {
  assert.deepEqual(workspaceFile(join(NAMES, "newonly")), {
    name: ".pitwall.json",
    path: join(NAMES, "newonly", ".pitwall.json"),
  });
  assert.deepEqual(workspaceFile(join(NAMES, "oldonly")), {
    name: ".autofix.json",
    path: join(NAMES, "oldonly", ".autofix.json"),
  });
  assert.equal(workspaceFile(join(NAMES, "both"))?.name, ".pitwall.json");
  assert.equal(workspaceFile(join(FIXTURES, "empty")), undefined);
});
