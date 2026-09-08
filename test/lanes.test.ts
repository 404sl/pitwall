import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Lane } from "@404sl/pitwall-schema";
import { readWorkspace } from "../src/autofix.ts";
import {
  handoffArgs,
  readLanes,
  recencyArgs,
  slotsPath,
  worktreePath,
  worktreePaths,
} from "../src/lanes.ts";

const PREFIX = "fixture";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function lockRoot(): string {
  return mkdtempSync(join(tmpdir(), "pitwall-lanes-"));
}

function claim(root: string, slot: number, issueId: string): void {
  const dir = slotsPath(PREFIX, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(slot)), `${issueId}\n`);
}

function registry(root: string): void {
  mkdirSync(slotsPath(PREFIX, root), { recursive: true });
}

function worktree(root: string, issueId: string, minutesAgo: number): string {
  return treeAt(worktreePath(PREFIX, issueId, root), minutesAgo);
}

function rework(root: string, issueId: string, minutesAgo: number): string {
  return treeAt(worktreePath(PREFIX, `${issueId}-rework`, root), minutesAgo);
}

function treeAt(dir: string, minutesAgo: number): string {
  const nested = join(dir, "src");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "index.ts"), "export {};\n");
  if (minutesAgo > 0) {
    const when = new Date(Date.now() - minutesAgo * 60_000);
    for (const path of [join(nested, "index.ts"), nested, dir]) {
      utimesSync(path, when, when);
    }
  }
  return dir;
}

function stateOf(lanes: readonly Lane[], slot: number): string | undefined {
  return lanes.find((lane) => lane.slot === slot)?.state;
}

const FIND_ALWAYS_FAILS = '#!/bin/sh\necho "find: probe rejected" >&2\nexit 1\n';

function findAcceptingOnly(primary: string): string {
  const real = spawnSync("/bin/sh", ["-c", "command -v find"], { encoding: "utf8" });
  const path = real.stdout.trim();
  return [
    "#!/bin/sh",
    'case " $* " in',
    `  *" ${primary} "*) exec ${path} "$@" ;;`,
    "esac",
    'echo "find: unknown primary or operator" >&2',
    "exit 1",
    "",
  ].join("\n");
}

function repo(root: string): string {
  const dir = join(root, "checkout");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ghListing(...pulls: Record<string, string>[]): string {
  return [
    "#!/bin/sh",
    `case "$*" in`,
    `  "${handoffArgs().join(" ")}") ;;`,
    '  *) echo "gh: unexpected arguments: $*" >&2; exit 2 ;;',
    "esac",
    "cat <<'JSON'",
    JSON.stringify(pulls),
    "JSON",
    "",
  ].join("\n");
}

const GH_ALWAYS_FAILS = '#!/bin/sh\necho "gh: not authenticated" >&2\nexit 4\n';

function withStub<T>(name: string, script: string, run: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "pitwall-stub-"));
  const stub = join(bin, name);
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = path === undefined ? bin : `${bin}:${path}`;
  try {
    return run();
  } finally {
    if (path === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = path;
    }
  }
}

test("a probe that fails is reported working with an error, never stranded", () => {
  const root = lockRoot();
  claim(root, 1, "pw-unprobed");
  const dir = worktree(root, "pw-unprobed", 0);

  const { lanes, errors } = withStub("find", FIND_ALWAYS_FAILS, () =>
    readLanes(PREFIX, { lockRoot: root }),
  );

  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.issueId, "pw-unprobed");
  assert.equal(lanes[0]?.worktree, dir);
  assert.equal(lanes[0]?.lastActivityAt, undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, dir);
  assert.match(errors[0]?.message ?? "", /probe rejected/);
});

test("a find that rejects every primary but -mmin still tells working from stranded", () => {
  const root = lockRoot();
  claim(root, 1, "pw-alive");
  claim(root, 2, "pw-dead");
  worktree(root, "pw-alive", 0);
  worktree(root, "pw-dead", 60);

  const { lanes, errors } = withStub("find", findAcceptingOnly("-mmin"), () =>
    readLanes(PREFIX, { lockRoot: root }),
  );

  assert.deepEqual(errors, []);
  assert.equal(stateOf(lanes, 1), "working");
  assert.match(lanes[0]?.lastActivityAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stateOf(lanes, 2), "stranded");
});

test("a worktree written to inside the window is working", () => {
  const root = lockRoot();
  claim(root, 1, "pw-alive");
  const dir = worktree(root, "pw-alive", 0);

  const { lanes, errors } = readLanes(PREFIX, { lockRoot: root });

  assert.deepEqual(errors, []);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.issueId, "pw-alive");
  assert.equal(lanes[0]?.worktree, dir);
  assert.match(lanes[0]?.lastActivityAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("recency asks find for -mmin and never -newermt, whose relative timestamp BSD find rejects", () => {
  assert.deepEqual(recencyArgs("/w/pw-alive"), ["/w/pw-alive", "-mmin", "-20"]);
});

test("a claimed slot whose lane has not taken a worktree yet is working, not handed-off", () => {
  const root = lockRoot();
  claim(root, 1, "pw-designing");
  const checkout = repo(root);

  const { lanes, errors } = withStub("gh", ghListing(), () =>
    readLanes(PREFIX, { lockRoot: root, repos: [checkout] }),
  );

  assert.deepEqual(errors, []);
  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.issueId, "pw-designing");
  assert.equal(lanes[0]?.worktree, undefined);
});

test("a claim with no worktree and a labelled pull request is handed-off", () => {
  const root = lockRoot();
  claim(root, 1, "pw-landed");
  const checkout = repo(root);

  const { lanes, errors } = withStub("gh", ghListing({ headRefName: "autofix/pw-landed" }), () =>
    readLanes(PREFIX, { lockRoot: root, repos: [checkout] }),
  );

  assert.deepEqual(errors, []);
  assert.equal(lanes[0]?.state, "handed-off");
  assert.equal(lanes[0]?.issueId, "pw-landed");
  assert.equal(lanes[0]?.worktree, undefined);
});

test("a labelled pull request that only cross-references the id does not hand it off", () => {
  const root = lockRoot();
  claim(root, 1, "pw-designing");
  const checkout = repo(root);

  const { lanes, errors } = withStub(
    "gh",
    ghListing({
      headRefName: "autofix/pw-other",
      title: "Refs pw-designing",
      body: "Refs pw-designing",
    }),
    () => readLanes(PREFIX, { lockRoot: root, repos: [checkout] }),
  );

  assert.deepEqual(errors, []);
  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.issueId, "pw-designing");
});

test("a labelled pull request for a dotted child does not hand off its parent", () => {
  const root = lockRoot();
  claim(root, 1, "pw-parent");
  const checkout = repo(root);

  const { lanes } = withStub("gh", ghListing({ headRefName: "autofix/pw-parent.1" }), () =>
    readLanes(PREFIX, { lockRoot: root, repos: [checkout] }),
  );

  assert.equal(lanes[0]?.state, "working");
});

test("a labelled pull request for a longer id does not hand off the shorter one", () => {
  const root = lockRoot();
  claim(root, 1, "pw-land");
  const checkout = repo(root);

  const { lanes } = withStub("gh", ghListing({ headRefName: "autofix/pw-landed" }), () =>
    readLanes(PREFIX, { lockRoot: root, repos: [checkout] }),
  );

  assert.equal(lanes[0]?.state, "working");
});

test("a gh that cannot be asked reports working with an error naming the checkout", () => {
  const root = lockRoot();
  claim(root, 1, "pw-unknown");
  const checkout = repo(root);

  const { lanes, errors } = withStub("gh", GH_ALWAYS_FAILS, () =>
    readLanes(PREFIX, { lockRoot: root, repos: [checkout] }),
  );

  assert.equal(lanes[0]?.state, "working");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, checkout);
  assert.match(errors[0]?.message ?? "", /not authenticated/);
});

test("handoff asks gh for open pull requests carrying lane-verified", () => {
  assert.deepEqual(handoffArgs(), [
    "pr",
    "list",
    "--state",
    "open",
    "--label",
    "lane-verified",
    "--limit",
    "200",
    "--json",
    "headRefName",
  ]);
});

test("no repo to ask leaves a claim with no worktree working rather than handed-off", () => {
  const root = lockRoot();
  claim(root, 1, "pw-unasked");

  const { lanes, errors } = readLanes(PREFIX, { lockRoot: root });

  assert.deepEqual(errors, []);
  assert.equal(lanes[0]?.state, "working");
});

test("the probed paths are the bare issue id and the same id suffixed -rework, in that order", () => {
  const root = lockRoot();

  assert.deepEqual(worktreePaths(PREFIX, "pw-x", root), [
    join(root, `${PREFIX}-worktrees`, "pw-x"),
    join(root, `${PREFIX}-worktrees`, "pw-x-rework"),
  ]);
});

test("a claim whose only worktree is the rework checkout is working, not handed-off", () => {
  const root = lockRoot();
  claim(root, 1, "pw-reworking");
  const dir = rework(root, "pw-reworking", 0);

  const { lanes, errors } = readLanes(PREFIX, { lockRoot: root });

  assert.deepEqual(errors, []);
  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.issueId, "pw-reworking");
  assert.equal(lanes[0]?.worktree, dir);
  assert.match(lanes[0]?.lastActivityAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("a rework checkout untouched past the window is stranded, naming the path measured", () => {
  const root = lockRoot();
  claim(root, 1, "pw-reworked");
  const dir = rework(root, "pw-reworked", 60);

  const { lanes } = readLanes(PREFIX, { lockRoot: root });

  assert.equal(lanes[0]?.state, "stranded");
  assert.equal(lanes[0]?.worktree, dir);
});

test("when both checkouts exist the freshest one decides, even when it is the rework", () => {
  const root = lockRoot();
  claim(root, 1, "pw-both");
  worktree(root, "pw-both", 5);
  const dir = rework(root, "pw-both", 0);

  const { lanes } = readLanes(PREFIX, { lockRoot: root });

  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.worktree, dir);
});

test("when both checkouts exist the freshest one decides, even when it is the build lane", () => {
  const root = lockRoot();
  claim(root, 1, "pw-both");
  const dir = worktree(root, "pw-both", 0);
  rework(root, "pw-both", 5);

  const { lanes } = readLanes(PREFIX, { lockRoot: root });

  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.worktree, dir);
});

test("a build lane past the window is stranded even beside a fresh rework of another id", () => {
  const root = lockRoot();
  claim(root, 1, "pw-dead");
  const dir = worktree(root, "pw-dead", 60);
  rework(root, "pw-other", 0);

  const { lanes } = readLanes(PREFIX, { lockRoot: root });

  assert.equal(lanes[0]?.state, "stranded");
  assert.equal(lanes[0]?.worktree, dir);
});

test("a claim whose worktree has been untouched past the window is stranded", () => {
  const root = lockRoot();
  claim(root, 1, "pw-dead");
  const dir = worktree(root, "pw-dead", 60);

  const { lanes } = readLanes(PREFIX, { lockRoot: root });

  assert.equal(lanes[0]?.state, "stranded");
  assert.equal(lanes[0]?.issueId, "pw-dead");
  assert.equal(lanes[0]?.worktree, dir);
});

test("a configured slot nobody claims is idle, because a released slot is deleted", () => {
  const root = lockRoot();
  claim(root, 2, "pw-alive");
  worktree(root, "pw-alive", 0);

  const { lanes } = readLanes(PREFIX, { lockRoot: root, lanes: 3 });

  assert.deepEqual(
    lanes.map((lane) => [lane.slot, lane.state]),
    [
      [1, "idle"],
      [2, "working"],
      [3, "idle"],
    ],
  );
  assert.equal(lanes[0]?.issueId, undefined);
});

test("a slot held above the configured lane count is still reported", () => {
  const root = lockRoot();
  claim(root, 7, "pw-drift");

  const { lanes } = readLanes(PREFIX, { lockRoot: root, lanes: 3 });

  assert.deepEqual(
    lanes.map((lane) => lane.slot),
    [1, 2, 3, 7],
  );
  assert.equal(stateOf(lanes, 7), "working");
});

test("the four states validate against the contract", () => {
  const root = lockRoot();
  claim(root, 1, "pw-alive");
  worktree(root, "pw-alive", 0);
  claim(root, 2, "pw-landed");
  claim(root, 3, "pw-dead");
  worktree(root, "pw-dead", 60);
  const checkout = repo(root);

  const { lanes } = withStub("gh", ghListing({ headRefName: "autofix/pw-landed" }), () =>
    readLanes(PREFIX, { lockRoot: root, lanes: 4, repos: [checkout] }),
  );

  assert.doesNotThrow(() => Lane.array().parse(lanes));
  assert.deepEqual(
    lanes.map((lane) => lane.state),
    ["working", "handed-off", "stranded", "idle"],
  );
});

test("a missing slots directory is zero lanes and no error", () => {
  const root = lockRoot();

  const { lanes, errors } = readLanes(PREFIX, { lockRoot: root, lanes: 3 });

  assert.deepEqual(lanes, []);
  assert.deepEqual(errors, []);
});

test("an empty registry still reports the configured lanes as idle", () => {
  const root = lockRoot();
  registry(root);

  const { lanes } = readLanes(PREFIX, { lockRoot: root, lanes: 2 });

  assert.deepEqual(
    lanes.map((lane) => lane.state),
    ["idle", "idle"],
  );
});

test("a slot file with nothing in it holds no claim", () => {
  const root = lockRoot();
  registry(root);
  writeFileSync(join(slotsPath(PREFIX, root), "1"), "\n");

  const { lanes } = readLanes(PREFIX, { lockRoot: root });

  assert.equal(lanes[0]?.state, "idle");
});

test("the registry is namespaced by lockPrefix, so one project cannot read another's", () => {
  const root = lockRoot();
  claim(root, 1, "pw-alive");

  const { lanes } = readLanes("other", { lockRoot: root });

  assert.deepEqual(lanes, []);
});

test("a workspace reports its lanes under the lockPrefix its config names", () => {
  const root = lockRoot();
  const fixtures = join(FIXTURES, "multi");
  mkdirSync(join(root, "multi-slots"), { recursive: true });
  writeFileSync(join(root, "multi-slots", "1"), "mw-alive\n");
  mkdirSync(join(root, "multi-worktrees", "mw-alive"), { recursive: true });

  const project = readWorkspace(fixtures, { lockRoot: root });

  assert.equal(project.lanes.length, 6);
  assert.equal(project.lanes[0]?.state, "working");
  assert.equal(project.lanes[0]?.issueId, "mw-alive");
  assert.deepEqual(
    project.lanes.slice(1).map((lane) => lane.state),
    ["idle", "idle", "idle", "idle", "idle"],
  );
  assert.deepEqual(project.errors, []);
});

test("a workspace whose registry has never been created reports no lanes", () => {
  const project = readWorkspace(join(FIXTURES, "multi"), {
    lockRoot: lockRoot(),
  });

  assert.deepEqual(project.lanes, []);
  assert.deepEqual(project.errors, []);
});

test("a slot file named with a leading zero holds its claim, and is never reported idle", () => {
  const root = lockRoot();
  registry(root);
  writeFileSync(join(slotsPath(PREFIX, root), "03"), "pw-zero\n");

  const { lanes, errors } = readLanes(PREFIX, { lockRoot: root, lanes: 3 });

  assert.deepEqual(errors, []);
  assert.deepEqual(
    lanes.map((lane) => [lane.slot, lane.state]),
    [
      [1, "idle"],
      [2, "idle"],
      [3, "working"],
    ],
  );
  assert.equal(lanes[2]?.issueId, "pw-zero");
});

test("a claim naming a path outside the worktree root is refused rather than walked", () => {
  const root = lockRoot();
  claim(root, 1, "../outside");
  treeAt(join(root, "outside"), 0);

  const { lanes, errors } = readLanes(PREFIX, { lockRoot: root });

  assert.doesNotThrow(() => Lane.array().parse(lanes));
  assert.equal(lanes[0]?.state, "working");
  assert.equal(lanes[0]?.issueId, undefined);
  assert.equal(lanes[0]?.worktree, undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, join(slotsPath(PREFIX, root), "1"));
  assert.match(errors[0]?.message ?? "", /\.\.\/outside/);
});
