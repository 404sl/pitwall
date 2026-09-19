import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const AUTHOR = { name: "Release Author", email: "release@example.invalid" };

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

interface Box {
  root: string;
  bare: string;
  repo: string;
  bin: string;
  ghLog: string;
}

function workspace(defaultBranch: string, configured: Record<string, unknown> | null): Box {
  const root = mkdtempSync(join(tmpdir(), "pitwall-supervisor-branch-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "site");
  mkdirSync(join(root, ".beads"));
  git(root, "init", "--bare", `--initial-branch=${defaultBranch}`, bare);
  git(root, "clone", "--quiet", bare, repo);
  writeFileSync(join(repo, "README.md"), "first\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", defaultBranch);
  git(repo, "checkout", "--quiet", "-b", "devloop/zz-aaa1");
  writeFileSync(join(repo, "README.md"), "first\nthe change a lane made\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the change a lane made");
  git(repo, "push", "--quiet", "-u", "origin", "devloop/zz-aaa1");
  git(repo, "checkout", "--quiet", defaultBranch);
  writeFileSync(join(repo, "README.md"), "first\nsomething else landed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "something else landed");
  git(repo, "push", "--quiet", "origin", defaultBranch);
  git(repo, "remote", "set-head", "origin", "--delete");
  git(repo, "remote", "set-url", "origin", "https://github.com/acme/site.git");
  git(repo, "remote", "set-url", "--push", "origin", bare);
  git(repo, "config", `url.${bare}.insteadOf`, "https://github.com/acme/site.git");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const ghLog = join(root, "gh.log");
  if (configured) {
    writeFileSync(
      join(root, ".pitwall.json"),
      JSON.stringify({ root, idPrefix: "zz", lockPrefix: `pwsuper${process.pid}`, repos: { site: { slug: "acme/site", ...configured } } }),
    );
  }
  return { root, bare, repo, bin, ghLog };
}

function ghStub(box: Box, body: string): void {
  writeFileSync(
    join(box.bin, "gh"),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(box.ghLog)}
${body}
`,
  );
  chmodSync(join(box.bin, "gh"), 0o755);
}

function script(box: Box, name: string, argv: string[]) {
  const ran = spawnSync("bash", [join(SKILL, name), ...argv], {
    cwd: box.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env.PATH}`,
      ...GIT_ENV,
      HOME: box.root,
      DEVLOOP_ROOT: box.root,
      PITWALL_CONFIG: undefined,
      DEVLOOP_CONFIG: undefined,
    },
  });
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

function ghCalls(box: Box): string[] {
  return existsSync(box.ghLog) ? readFileSync(box.ghLog, "utf8").trim().split("\n") : [];
}

function firstGhCall(box: Box): string {
  return ghCalls(box)[0] ?? "";
}

test("master-watch.sh watches the configured default branch, not master", () => {
  const box = workspace("main", { defaultBranch: "main" });
  try {
    const head = git(box.repo, "rev-parse", "origin/main");
    ghStub(box, `case "$1 $2" in
  "run list") echo '[{"headSha":"${head}","status":"completed","conclusion":"success","displayTitle":"landed"}]' ;;
  *) exit 0 ;;
esac`);
    const ran = script(box, "master-watch.sh", ["--repo-path", box.repo, "--once"]);
    assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
    assert.equal(ran.out, `success\t${head.slice(0, 8)}\tlanded\n`, `the watch did not report main's own head:\n${ran.out}${ran.err}`);
    const calls = ghCalls(box);
    assert.equal(calls.length, 1, `expected one gh call, saw:\n${calls.join("\n")}`);
    assert.match(firstGhCall(box), /--branch main\b/, `gh was not asked about main:\n${calls.join("\n")}`);
    assert.doesNotMatch(firstGhCall(box), /--branch master\b/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("master-watch.sh with no defaultBranch configured still watches master", () => {
  const box = workspace("master", {});
  try {
    const head = git(box.repo, "rev-parse", "origin/master");
    ghStub(box, `case "$1 $2" in
  "run list") echo '[{"headSha":"${head}","status":"completed","conclusion":"failure","displayTitle":"broke"}]' ;;
  *) exit 0 ;;
esac`);
    const ran = script(box, "master-watch.sh", ["--repo-path", box.repo, "--once"]);
    assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
    assert.equal(ran.out, `failure\t${head.slice(0, 8)}\tbroke\n`);
    assert.match(firstGhCall(box), /--branch master\b/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("master-watch.sh with no workspace config at all watches master", () => {
  const box = workspace("master", null);
  try {
    const head = git(box.repo, "rev-parse", "origin/master");
    ghStub(box, `echo '[{"headSha":"${head}","status":"completed","conclusion":"success","displayTitle":"landed"}]'`);
    const ran = script(box, "master-watch.sh", ["--repo-path", box.repo, "--once"]);
    assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
    assert.equal(ran.out, `success\t${head.slice(0, 8)}\tlanded\n`);
    assert.match(firstGhCall(box), /--branch master\b/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("stranded.sh measures a pull request against the configured default branch", () => {
  const box = workspace("main", { defaultBranch: "main" });
  try {
    ghStub(box, `case "$1 $2" in
  "pr list") echo '1 devloop/zz-aaa1 labelled' ;;
  *) exit 0 ;;
esac`);
    const ran = script(box, "stranded.sh", []);
    assert.equal(ran.code, 1, `the conflicting branch was not reported:\n${ran.out}${ran.err}`);
    assert.match(ran.out, /site\s+#1\s+devloop\/zz-aaa1/);
    assert.match(ran.out, /1 conflict\(s\): README\.md/, `the conflict was not measured against origin/main:\n${ran.out}`);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("stranded.sh reports a clean branch as clean against the configured default branch", () => {
  const box = workspace("main", { defaultBranch: "main" });
  try {
    git(box.repo, "checkout", "--quiet", "devloop/zz-aaa1");
    git(box.repo, "reset", "--quiet", "--hard", "origin/main");
    writeFileSync(join(box.repo, "fix.txt"), "no overlap\n");
    git(box.repo, "add", "-A");
    git(box.repo, "commit", "-m", "a change that merges");
    git(box.repo, "push", "--quiet", "--force", "origin", "devloop/zz-aaa1");
    git(box.repo, "checkout", "--quiet", "main");
    ghStub(box, `case "$1 $2" in
  "pr list") echo '1 devloop/zz-aaa1 labelled' ;;
  *) exit 0 ;;
esac`);
    const ran = script(box, "stranded.sh", []);
    assert.equal(ran.code, 0, `a branch that merges into main was reported stranded:\n${ran.out}${ran.err}`);
    assert.match(ran.out, /nothing stranded/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

function sshStub(box: Box, revision: string): void {
  writeFileSync(join(box.bin, "ssh"), `#!/bin/bash\nprintf 'production ${revision}\\nstaging ${revision}\\n'\n`);
  chmodSync(join(box.bin, "ssh"), 0o755);
}

test("deployed.sh compares the servers with the configured default branch", () => {
  const box = workspace("main", { defaultBranch: "main" });
  try {
    const first = git(box.repo, "rev-parse", "origin/main~1");
    sshStub(box, first);
    const ran = script(box, "deployed.sh", []);
    assert.equal(ran.code, 1, `the servers sit one commit behind main and it was not reported:\n${ran.out}${ran.err}`);
    assert.match(ran.out, /^main\s+[0-9a-f]{8}/m, `the table does not lead with main:\n${ran.out}`);
    assert.match(ran.out, /BEHIND by 1 commit/);
    assert.match(ran.out, /Undeployed on main:/);
    assert.doesNotMatch(ran.err, /origin\/master/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("deployed.sh with no defaultBranch configured still reads origin/master", () => {
  const box = workspace("master", {});
  try {
    sshStub(box, git(box.repo, "rev-parse", "origin/master"));
    const ran = script(box, "deployed.sh", []);
    assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
    assert.match(ran.out, /master, staging and production agree/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("default-branch.sh answers from the config and says master when nothing is configured", () => {
  const box = workspace("main", { defaultBranch: "main" });
  const bare = workspace("master", null);
  try {
    assert.equal(script(box, "default-branch.sh", ["--checkout", box.repo]).out, "main\n");
    assert.equal(script(box, "default-branch.sh", ["--all"]).out, "main\n");
    assert.equal(script(bare, "default-branch.sh", ["--checkout", bare.repo]).out, "master\n");
    assert.equal(script(bare, "default-branch.sh", ["--all"]).out, "master\n");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
    rmSync(bare.root, { recursive: true, force: true });
  }
});
