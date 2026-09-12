import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };
const PREFIX = `mergeshaped-${process.pid}`;
const WORK = join("src", "board.ts");

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function tryGit(cwd: string, ...argv: string[]) {
  return spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
}

function write(dir: string, relative: string, body: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function stubs(root: string, bare: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
case "$1 $2" in
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr checks") exit 0 ;;
  "pr view")   echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"SUCCESS"}],"headRefOid":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse "refs/heads/$BRANCH_UNDER_TEST" 2>/dev/null)"'"}' ;;
  *) exit 0 ;;
esac
`,
  );
  writeFileSync(
    join(bin, "git-guard"),
    `#!/bin/bash
while [ $# -gt 0 ]; do
  [ "$1" = "--" ] && { shift; break; }
  shift
done
exec "$@"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git-guard"), 0o755);
  return bin;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lander-merge-shaped-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, WORK, "export const lanes = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  return { root, bare, repo, bin: stubs(root, bare) };
}

function onMaster(repo: string, body: string, subject: string): void {
  git(repo, "checkout", "--quiet", "master");
  write(repo, WORK, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", subject);
  git(repo, "push", "--quiet", "origin", "master");
}

function lane(repo: string, branch: string, file: string, body: string): void {
  git(repo, "checkout", "--quiet", "master");
  git(repo, "checkout", "--quiet", "-b", branch);
  write(repo, file, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `work on ${file}`);
  git(repo, "push", "--quiet", "-u", "origin", branch);
  git(repo, "checkout", "--quiet", "master");
}

function resolveMasterInto(repo: string, branch: string, resolution: string): void {
  git(repo, "checkout", "--quiet", branch);
  const merged = tryGit(repo, "merge", "--no-ff", "master");
  assert.notEqual(merged.status, 0, "the merge did not conflict, so the resolution edit would not be unique to it");
  write(repo, WORK, resolution);
  git(repo, "add", "-A");
  git(repo, "commit", "--no-edit");
  git(repo, "push", "--quiet", "origin", branch);
  git(repo, "checkout", "--quiet", "master");
}

function landOne(root: string, repo: string, bin: string, branch: string, pr: string) {
  const ran = spawnSync(
    "bash",
    [join(SKILL, "land-one.sh"), "--repo-path", repo, "--slug", "acme/site", "--pr", pr, "--branch", branch, "--prefix", PREFIX],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...GIT_ENV,
        BRANCH_UNDER_TEST: branch,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "true",
        HOME: root,
      },
    },
  );
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

test("land-one.sh defers a merge-shaped branch instead of rebasing the resolution away", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-merged", WORK, "export const lanes = 2;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");
  resolveMasterInto(box.repo, "devloop/zz-merged", "export const lanes = 2 + 3;\n");
  onMaster(box.repo, "export const lanes = 3;\nexport const pits = 1;\n", "master moves again");

  const head = git(box.repo, "rev-parse", "origin/devloop/zz-merged");
  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-merged", "301");

  assert.equal(
    ran.code,
    8,
    "a branch whose only copy of the resolution lives inside a merge commit was handed to the " +
      `rebase, which replays the branch's own commits and drops it silently:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /^merge_shaped:/m, ran.out);
  assert.ok(!/^(conflict|red):/m.test(ran.out), `the deferral was reported as the failure family land.js retires: ${ran.out}`);
  git(box.repo, "fetch", "--quiet", "origin");
  assert.equal(git(box.repo, "rev-parse", "origin/devloop/zz-merged"), head, "the branch was touched before it was deferred");
  assert.equal(
    git(box.repo, "show", "origin/devloop/zz-merged:" + WORK),
    "export const lanes = 2 + 3;",
    "the resolution that exists only inside the merge commit is gone",
  );
  assert.equal(existsSync(join("/tmp", `${PREFIX}-worktrees`, "land-301")), false, "a worktree was left behind by a run that touched nothing");
});

test("land-one.sh rebases a linear branch that is behind master exactly as before", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-linear", join("src", "pit.ts"), "export const pit = 1;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");

  const head = git(box.repo, "rev-parse", "origin/devloop/zz-linear");
  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-linear", "302");

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^pushed:/m, ran.out);
  git(box.repo, "fetch", "--quiet", "origin");
  assert.notEqual(git(box.repo, "rev-parse", "origin/devloop/zz-linear"), head, "a branch behind master was not rebased");
});

test("land-one.sh leaves a merge-shaped branch that is already on top of master alone", () => {
  const box = workspace();
  lane(box.repo, "devloop/zz-current", WORK, "export const lanes = 2;\n");
  onMaster(box.repo, "export const lanes = 3;\n", "master moves under the branch");
  resolveMasterInto(box.repo, "devloop/zz-current", "export const lanes = 2 + 3;\n");

  const ran = landOne(box.root, box.repo, box.bin, "devloop/zz-current", "303");

  assert.equal(
    ran.code,
    0,
    "a merge-shaped branch that no rebase would touch was deferred anyway, which parks landable " +
      `work forever - nothing is ever going to make that branch linear:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /^current:/m, ran.out);
});

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "lander-1788964650-29574",
  repos: { site: { path: "cli", slug: "404sl/pitwall" } },
};

const PR = {
  slug: "404sl/pitwall",
  number: 80,
  title: "Verify the lane rescue diff before removing the worktree",
  branch: "devloop/pitwall-maz",
  issue: "pitwall-maz",
};

const DECLARED = {
  fetched: true,
  status: "read",
  prStatus: "read",
  masterVersion: "0.1.21",
  branchVersion: "0.1.22",
  touchesPlugin: true,
  labelled: true,
  open: true,
  notes: "",
};

type Result = {
  landed: { number?: number }[];
  stopped: { number?: number; why?: string; detail?: string }[];
};

function lander(land: unknown) {
  return runScript("land.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: ARGS.lockToken, holder: ARGS.lockToken };
    if (call.label.startsWith("survey")) return { prs: [PR] };
    if (call.label.startsWith("version:")) return DECLARED;
    if (call.label.startsWith("land:")) return land;
    return { status: "released" };
  }) as { calls: Call[]; logs: string[]; done: Promise<Result> };
}

function labels(calls: Call[]) {
  return calls.map((c) => c.label).join(", ");
}

test("land.js hands a merge-shaped pull request back for rework rather than retiring it", async () => {
  const { calls, logs, done } = lander({ status: "merge_shaped", masterGreen: true, notes: "land-one.sh exit 8" });
  const out = await done;

  assert.equal(
    calls.filter((c) => c.label.startsWith("retire:")).length,
    0,
    "a branch the lander declined to rebase was retired - the label comes off, the finding is " +
      "appended to the tracker issue and the issue is reopened, which discards work that is " +
      `green and only needs rebuilding onto master: ${labels(calls)}`,
  );
  assert.equal(out.landed.length, 0);
  assert.deepEqual(
    out.stopped.map((s) => s.why),
    ["merge_shaped"],
    `the run did not record why the pull request was handed back: ${labels(calls)}`,
  );
  assert.equal(
    calls.filter((c) => c.label.startsWith("land:")).length,
    1,
    "the pull request was attempted again in a later round. A merge-shaped branch answers the " +
      `same way every time, so retrying it spends a whole attempt on a settled answer: ${labels(calls)}`,
  );
  assert.ok(
    logs.some((l) => /NEEDS REWORK/.test(l) && /label stays on/.test(l)),
    `the run log does not say the label was kept, so a reader cannot tell this from a retirement:\n${logs.join("\n")}`,
  );
});

test("the land agent is allowed to report a merge-shaped branch at all", async () => {
  const { calls, done } = lander({ status: "merge_shaped", masterGreen: true, notes: "land-one.sh exit 8" });
  await done;

  const land = calls.find((c) => c.label.startsWith("land:"));
  assert.ok(land, `no merge attempt was made: ${labels(calls)}`);
  assert.ok(
    (land.schema?.properties?.status?.enum || []).includes("merge_shaped"),
    "the schema the merge agent answers against has no value for a branch it must not rebase, so " +
      "the honest answer is unavailable and it has to pick 'conflict' - which is retired.",
  );
  assert.match(
    land.prompt,
    /8\s+merge_shaped/,
    "the merge agent is never told what exit 8 means, so it has to guess which status to return",
  );
});
