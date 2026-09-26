import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const CONFIG_SH = join(SKILL, "config.sh");
const AUTHOR = { name: "Release Author", email: "release@example.invalid" };

let sequence = 0;

function ghStub(bin: string, answers: Record<string, string>, prBase?: string): void {
  const cases = Object.entries(answers)
    .map(([slug, body]) => `  "repo view ${slug}") ${body} ;;`)
    .join("\n");
  const view = prBase ? `  "api repos/"*"/pulls/"*) echo '{"base":{"ref":"${prBase}"},"labels":[{"name":"lane-verified"}],"head":{"sha":""}}' ;;\n` : "";
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
case "$1 $2 $3" in
${cases}
${view}  "run list "*)  echo '[{"status":"completed","conclusion":"success"}]' ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
}

function says(branch: string): string {
  return `echo '{"defaultBranchRef":{"name":"${branch}"}}'`;
}

interface Box {
  root: string;
  bin: string;
  config: string;
  prefix: string;
}

function workspace(repos: Record<string, Record<string, unknown>>, answers: Record<string, string>): Box {
  const root = mkdtempSync(join(tmpdir(), "pitwall-default-branch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  const prefix = `pwbranch${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ root, idPrefix: "zz", lockPrefix: prefix, lanes: 2, repos }));
  writeFileSync(join(bin, "bd"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "bd"), 0o755);
  ghStub(bin, answers);
  return { root, bin, config, prefix };
}

function clean(box: Box): void {
  rmSync(slotsPath(box.prefix), { recursive: true, force: true });
  for (let lane = 1; lane <= 9; lane += 1) {
    rmSync(join(LOCK_ROOT, `${box.prefix}-lane-${lane}.lock`), { recursive: true, force: true });
  }
  rmSync(box.root, { recursive: true, force: true });
}

function config(box: Box, ...argv: string[]) {
  return configWith(box, {}, ...argv);
}

function configWith(box: Box, extra: Record<string, string>, ...argv: string[]) {
  const ran = spawnSync("bash", [CONFIG_SH, ...argv], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      ...extra,
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

type Args = { repos: Record<string, { defaultBranch?: string }> };

test("a repository with no defaultBranch is dispatched against master, exactly as before", () => {
  const box = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site", deploy: ["bash deploy-one.sh --label production --repo-path repo"] } },
    { "acme/site": says("master") },
  );
  try {
    for (const mode of [["--args", "zz-aaa1"], ["--land"], ["--train", "site"]]) {
      const ran = config(box, ...mode);
      assert.equal(ran.status, 0, `${mode.join(" ")}: ${ran.stderr}`);
      const args = JSON.parse(ran.stdout) as Args;
      assert.equal(args.repos["site"]?.defaultBranch, "master", `${mode.join(" ")} did not fill the default in`);
    }
  } finally {
    clean(box);
  }
});

test("a configured defaultBranch travels in the args object every consumer reads", () => {
  const box = workspace(
    {
      site: { path: "repo", test: "npm test", slug: "acme/site", defaultBranch: "blueprint-pro-master" },
      docs: { path: "repo", test: "npm test" },
    },
    { "acme/site": says("blueprint-pro-master") },
  );
  try {
    const args = config(box, "--args", "zz-aaa1");
    assert.equal(args.status, 0, args.stderr);
    const dispatched = JSON.parse(args.stdout) as Args;
    assert.equal(dispatched.repos["site"]?.defaultBranch, "blueprint-pro-master");
    assert.equal(dispatched.repos["docs"]?.defaultBranch, "master", "a repository without the field is still master");

    const rework = config(box, "--rework", "zz-aaa1", "7", "site");
    assert.equal(rework.status, 0, rework.stderr);
    assert.equal((JSON.parse(rework.stdout) as Args).repos["site"]?.defaultBranch, "blueprint-pro-master");

    const train = config(box, "--train", "site");
    assert.equal(train.status, 0, train.stderr);
    assert.equal((JSON.parse(train.stdout) as Args).repos["site"]?.defaultBranch, "blueprint-pro-master");
  } finally {
    clean(box);
  }
});

test("a default branch GitHub disagrees with is refused before any lane is reserved, naming both", () => {
  const box = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site" } },
    { "acme/site": says("main") },
  );
  try {
    for (const mode of [["--args", "zz-aaa1"], ["--rework", "zz-aaa1", "7", "site"], ["--land"], ["--train", "site"]]) {
      const ran = config(box, ...mode);
      assert.notEqual(ran.status, 0, `${mode.join(" ")} dispatched against a base GitHub does not use:\n${ran.stdout}`);
      assert.equal(ran.stdout, "", `${mode.join(" ")} printed an args object alongside its refusal`);
      assert.match(ran.stderr, /'master'/, `${mode.join(" ")} did not name the configured branch:\n${ran.stderr}`);
      assert.match(ran.stderr, /'main'/, `${mode.join(" ")} did not name the branch GitHub reports:\n${ran.stderr}`);
      assert.match(ran.stderr, /repo site/, `${mode.join(" ")} did not name the repository:\n${ran.stderr}`);
    }
    assert.equal(existsSync(slotsPath(box.prefix)), false, "a refused dispatch left a lane reserved");

    const check = config(box, "--check");
    assert.notEqual(check.status, 0, "--check passed a config whose branch GitHub disagrees with");
    assert.match(check.stdout, /'master'.*'main'|'main'.*'master'/s);
  } finally {
    clean(box);
  }
});

test("a default branch GitHub cannot report is refused rather than assumed", () => {
  const box = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site" } },
    { "acme/site": "echo 'gh: Could not resolve to a Repository' >&2; exit 1" },
  );
  try {
    const ran = config(box, "--args", "zz-aaa1");
    assert.notEqual(ran.status, 0, "an unreadable default branch was read as agreeing");
    assert.match(ran.stderr, /could not read the default branch of acme\/site/);
    assert.match(ran.stderr, /gh repo view acme\/site --json defaultBranchRef/);
    assert.match(ran.stderr, /Could not resolve to a Repository/);
  } finally {
    clean(box);
  }
});

test("a deploy-one.sh entry that would ship a branch other than the repository's default is refused", () => {
  const entry = (base: string) => `bash deploy-one.sh --label production --repo-path repo${base ? ` --base ${base}` : ""} --deploy 'echo ship' --revision 'echo abc'`;
  const unbased = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site", defaultBranch: "main", deploy: [entry("")] } },
    { "acme/site": says("main") },
  );
  try {
    for (const mode of [["--args", "zz-aaa1"], ["--land"], ["--train", "site"]]) {
      const ran = config(unbased, ...mode);
      assert.notEqual(ran.status, 0, `${mode.join(" ")} dispatched a deploy that would ship origin/master to a main repository:\n${ran.stdout}`);
      assert.equal(ran.stdout, "", `${mode.join(" ")} printed an args object alongside its refusal`);
      assert.match(ran.stderr, /repos\.site\.deploy entry 'production'/, `${mode.join(" ")} did not name the deploy entry:\n${ran.stderr}`);
      assert.match(ran.stderr, /origin\/master/, `${mode.join(" ")} did not name the branch the deploy would ship:\n${ran.stderr}`);
      assert.match(ran.stderr, /'main'/, `${mode.join(" ")} did not name the configured branch:\n${ran.stderr}`);
      assert.match(ran.stderr, /--base main/, `${mode.join(" ")} did not say what to add:\n${ran.stderr}`);
    }
    assert.equal(existsSync(slotsPath(unbased.prefix)), false, "a refused dispatch left a lane reserved");
    const check = config(unbased, "--check");
    assert.notEqual(check.status, 0, "--check passed a deploy entry that ships the wrong branch");
    assert.match(check.stdout, /deploy entry 'production'/);
  } finally {
    clean(unbased);
  }

  const based = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site", defaultBranch: "main", deploy: [entry("main")] } },
    { "acme/site": says("main") },
  );
  try {
    const ran = config(based, "--land");
    assert.equal(ran.status, 0, `a deploy entry carrying --base main was refused for a main repository:\n${ran.stderr}`);
  } finally {
    clean(based);
  }

  const crossed = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site", deploy: [entry("main")] } },
    { "acme/site": says("master") },
  );
  try {
    const ran = config(crossed, "--land");
    assert.notEqual(ran.status, 0, "a deploy entry shipping origin/main was accepted for a master repository");
    assert.match(ran.stderr, /origin\/main/);
    assert.match(ran.stderr, /'master'/);
  } finally {
    clean(crossed);
  }
});

function sleeps(seconds: number, finished: string): string {
  return `sleep ${seconds} && date +%s > ${JSON.stringify(finished)}`;
}

test("a gh that never answers is refused within the bound rather than waited on", () => {
  const box = workspace({ site: { path: "repo", test: "npm test", slug: "acme/site" } }, {});
  const finished = join(box.root, "gh-finished");
  ghStub(box.bin, { "acme/site": sleeps(5, finished) });
  try {
    const started = Date.now();
    const ran = configWith(box, { DEVLOOP_GH_TIMEOUT: "1" }, "--args", "zz-aaa1");
    const took = Date.now() - started;
    assert.equal(existsSync(finished), false, `config.sh let a gh bounded to 1s sleep its full 5s before refusing (${took}ms in all)`);
    assert.notEqual(ran.status, 0, "a dispatch proceeded on a default branch gh never reported");
    assert.equal(ran.stdout, "", "an args object was printed alongside the refusal");
    assert.match(ran.stderr, /could not read the default branch of acme\/site/);
    assert.match(ran.stderr, /timed out after 1s/, `the refusal does not say gh timed out:\n${ran.stderr}`);
    assert.equal(existsSync(slotsPath(box.prefix)), false, "a refused dispatch left a lane reserved");
  } finally {
    clean(box);
  }
});

test("a defaultBranch written as a ref rather than a branch name is refused", () => {
  const box = workspace(
    { site: { path: "repo", test: "npm test", slug: "acme/site", defaultBranch: "origin/main" } },
    { "acme/site": says("main") },
  );
  try {
    const ran = config(box, "--args", "zz-aaa1");
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /repos\.site\.defaultBranch is "origin\/main"/);
  } finally {
    clean(box);
  }
});

test("--check names every repository that is wrong, while a dispatch still refuses on the first with empty stdout", () => {
  const box = workspace(
    {
      site: { path: "repo", test: "npm test", slug: "acme/site" },
      docs: { path: "repo", test: "npm test", slug: "acme/docs", defaultBranch: "main", deploy: ["bash deploy-one.sh --label production --repo-path repo --deploy 'echo ship' --revision 'echo abc'"] },
      api: { path: "repo", test: "npm test", slug: "acme/api", defaultBranch: "origin/main" },
    },
    { "acme/site": says("main"), "acme/docs": says("main"), "acme/api": says("main") },
  );
  try {
    const check = config(box, "--check");
    assert.notEqual(check.status, 0, "--check passed a config with three wrong repositories");
    assert.match(check.stdout, /repo site \(acme\/site\) has default branch 'master'.*GitHub says its\s+default branch is 'main'/s, `--check does not name the branch GitHub disagrees with:\n${check.stdout}`);
    assert.match(check.stdout, /repos\.docs\.deploy entry 'production' would deploy origin\/master/, `--check does not name the deploy entry:\n${check.stdout}`);
    assert.match(check.stdout, /repos\.api\.defaultBranch is "origin\/main"/, `--check does not name the rejected branch name:\n${check.stdout}`);
    assert.equal(check.stdout.includes("repo api (acme/api)"), false, `--check compared a rejected branch name with GitHub:\n${check.stdout}`);

    for (const mode of [["--args", "zz-aaa1"], ["--rework", "zz-aaa1", "7", "site"], ["--land"], ["--train", "site"]]) {
      const ran = config(box, ...mode);
      assert.notEqual(ran.status, 0, `${mode.join(" ")} dispatched a config --check refuses:\n${ran.stdout}`);
      assert.equal(ran.stdout, "", `${mode.join(" ")} printed an args object alongside its refusal`);
      assert.match(ran.stderr, /config\.sh: /, `${mode.join(" ")} refused without saying why:\n${ran.stderr}`);
    }
    assert.equal(existsSync(slotsPath(box.prefix)), false, "a refused dispatch left a lane reserved");
  } finally {
    clean(box);
  }
});

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv], { cwd });
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function write(dir: string, relative: string, body: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function checkout(defaultBranch: string) {
  const root = mkdtempSync(join(tmpdir(), "pitwall-default-branch-git-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--bare", `--initial-branch=${defaultBranch}`, bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, "README.md", "first\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", defaultBranch);
  git(repo, "checkout", "--quiet", "-b", "devloop/zz-aaa1");
  write(repo, "fix.txt", "the change a lane made\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the change a lane made");
  git(repo, "push", "--quiet", "-u", "origin", "devloop/zz-aaa1");
  git(repo, "checkout", "--quiet", defaultBranch);
  write(repo, "README.md", "first\nsomething else landed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "something else landed");
  git(repo, "push", "--quiet", "origin", defaultBranch);
  const bin = join(root, "bin");
  mkdirSync(bin);
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
  chmodSync(join(bin, "git-guard"), 0o755);
  return { root, bare, repo, bin };
}

function script(root: string, bin: string, name: string, argv: string[], extra: Record<string, string> = {}) {
  const ran = spawnSync("bash", [join(SKILL, name), ...argv], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ...GIT_ENV,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
      HOME: root,
      ...extra,
    },
  });
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

test("land-one.sh refuses a base GitHub does not report as the default, before cutting a worktree", () => {
  const box = checkout("main");
  const prefix = `pwbranchone${process.pid}`;
  try {
    ghStub(box.bin, { "acme/site": says("main") });
    const ran = script(box.root, box.bin, "land-one.sh", [
      "--repo-path", box.repo, "--slug", "acme/site", "--pr", "7", "--branch", "devloop/zz-aaa1", "--prefix", prefix,
    ]);
    assert.equal(ran.code, 6, `expected a usage refusal, got ${ran.code}:\n${ran.out}\n${ran.err}`);
    assert.match(ran.out, /'master'/, `the refusal does not name the base it was handed:\n${ran.out}`);
    assert.match(ran.out, /'main'/, `the refusal does not name the branch GitHub reports:\n${ran.out}`);
    assert.equal(existsSync(join("/tmp", `${prefix}-worktrees`, "land-7")), false, "a worktree was cut before the refusal");
    assert.equal(git(box.bare, "rev-parse", "refs/heads/devloop/zz-aaa1"), git(box.repo, "rev-parse", "origin/devloop/zz-aaa1"), "the branch head was moved");
  } finally {
    rmSync(join("/tmp", `${prefix}-worktrees`), { recursive: true, force: true });
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("land-one.sh rebases onto the base it is handed when GitHub agrees with it", () => {
  const box = checkout("main");
  const prefix = `pwbranchtwo${process.pid}`;
  try {
    ghStub(box.bin, { "acme/site": says("main") }, "main");
    const before = git(box.bare, "rev-parse", "refs/heads/devloop/zz-aaa1");
    const ran = script(box.root, box.bin, "land-one.sh", [
      "--repo-path", box.repo, "--slug", "acme/site", "--pr", "7", "--branch", "devloop/zz-aaa1", "--prefix", prefix,
      "--base", "main", "--register-wait", "0",
    ]);
    assert.match(ran.out, /pushed: devloop\/zz-aaa1 was 1 behind main/, `the branch was not rebased onto main:\n${ran.out}\n${ran.err}`);
    const after = git(box.bare, "rev-parse", "refs/heads/devloop/zz-aaa1");
    assert.notEqual(after, before, "nothing was pushed");
    assert.equal(git(box.bare, "merge-base", "--is-ancestor", "refs/heads/main", "refs/heads/devloop/zz-aaa1"), "", "the pushed head does not sit on main");
  } finally {
    rmSync(join("/tmp", `${prefix}-worktrees`), { recursive: true, force: true });
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("land-train.sh cuts the train from the base it is handed and opens its pull request against it", () => {
  const box = checkout("main");
  const prefix = `pwbranchtrain${process.pid}`;
  try {
    writeFileSync(
      join(box.bin, "gh"),
      `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr list")   echo '[{"number":101,"title":"the change a lane made","headRefName":"devloop/zz-aaa1","createdAt":"2026-01-01T00:00:00Z"}]' ;;
  "pr create") printf '%s\\n' "$@" > ${JSON.stringify(join(box.root, "pr-create.args"))}; echo "https://github.com/acme/site/pull/200" ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(join(box.bin, "gh"), 0o755);
    const ran = script(box.root, box.bin, "land-train.sh", [
      "--repo-path", box.repo, "--slug", "acme/site", "--prefix", prefix, "--base", "main",
    ]);
    assert.equal(ran.code, 0, `the train did not build:\n${ran.out}\n${ran.err}`);
    assert.match(ran.out, /cut from main at/, `the train was not cut from main:\n${ran.out}`);
    const created = spawnSync("cat", [join(box.root, "pr-create.args")], { encoding: "utf8" }).stdout.split("\n");
    assert.equal(created[created.indexOf("--base") + 1], "main", `gh pr create was not passed --base main:\n${created.join(" ")}`);
    const train = git(box.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/release/*");
    assert.notEqual(train, "", "no release branch reached the remote");
    assert.equal(git(box.bare, "merge-base", "--is-ancestor", "refs/heads/main", train), "", "the train does not sit on main");
  } finally {
    rmSync(join("/tmp", `${prefix}-worktrees`), { recursive: true, force: true });
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("land-one.sh and land-train.sh give up on a gh that never answers, before cutting a worktree", () => {
  const box = checkout("main");
  const prefix = `pwbranchhang${process.pid}`;
  try {
    const runs = [
      ["land-one.sh", ["--repo-path", box.repo, "--slug", "acme/site", "--pr", "7", "--branch", "devloop/zz-aaa1", "--prefix", prefix, "--base", "main"]],
      ["land-train.sh", ["--repo-path", box.repo, "--slug", "acme/site", "--prefix", prefix, "--base", "main"]],
    ] as const;
    for (const [name, argv] of runs) {
      const finished = join(box.root, `gh-finished-${name}`);
      ghStub(box.bin, { "acme/site": sleeps(5, finished) });
      const started = Date.now();
      const ran = script(box.root, box.bin, name, [...argv], { DEVLOOP_GH_TIMEOUT: "1" });
      const took = Date.now() - started;
      assert.equal(existsSync(finished), false, `${name} let a gh bounded to 1s sleep its full 5s before refusing (${took}ms in all)`);
      assert.equal(ran.code, 6, `${name}: expected a usage refusal, got ${ran.code}:\n${ran.out}\n${ran.err}`);
      assert.match(ran.out, /could not read the default branch of acme\/site/, `${name}:\n${ran.out}`);
      assert.match(ran.out, /within 1s/, `${name} does not say how long it waited:\n${ran.out}`);
    }
    assert.equal(existsSync(join("/tmp", `${prefix}-worktrees`)), false, "a worktree was cut before the refusal");
  } finally {
    rmSync(join("/tmp", `${prefix}-worktrees`), { recursive: true, force: true });
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("lane-handoff.sh --pre-push grades the range above the base it is handed", () => {
  const box = checkout("main");
  try {
    ghStub(box.bin, { "acme/site": says("main") });
    git(box.repo, "checkout", "--quiet", "devloop/zz-aaa1");
    const ran = script(box.root, box.bin, "lane-handoff.sh", ["--repo-path", box.repo, "--pre-push", "--base", "main"]);
    assert.equal(ran.code, 0, `the range above main was not read as clear:\n${ran.out}\n${ran.err}`);
    assert.match(ran.out, /origin\/main\.\.HEAD/, `the verdict does not name the base it measured from:\n${ran.out}`);
    const absent = script(box.root, box.bin, "lane-handoff.sh", ["--repo-path", box.repo, "--pre-push"]);
    assert.equal(absent.code, 6, "with no --base the check measured from something other than origin/master, which this checkout does not have");
    assert.match(absent.err, /no origin\/master/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  lockToken: "lander-1788964650-29574",
  repos: { site: { path: "cli", slug: "404sl/pitwall", defaultBranch: "blueprint-pro-master" } },
};

const PR = {
  slug: "404sl/pitwall",
  number: 80,
  title: "Verify the lane rescue diff before removing the worktree",
  branch: "devloop/pitwall-maz",
  issue: "pitwall-maz",
};

test("land.js hands the configured base to land-one.sh and names it in every command it dictates", async () => {
  const { calls, done } = runScript("land.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", token: ARGS.lockToken, holder: ARGS.lockToken };
    if (call.label.startsWith("survey")) return { prs: [PR] };
    if (call.label.startsWith("version:")) return { fetched: true, status: "no_manifest", prStatus: "read", touchesPlugin: false, labelled: true, open: true };
    if (call.label.startsWith("land:")) return { status: "blocked", notes: "stopped by the test" };
    return { status: "released" };
  });
  await done;
  const land = calls.find((c) => c.label.startsWith("land:"));
  assert.ok(land, "no land step ran");
  assert.match(land.prompt, /land-one\.sh [^\n]* --base blueprint-pro-master/, "land-one.sh is not handed the configured base");
  assert.equal(land.prompt.includes("origin/master"), false, `the land brief still names origin/master:\n${land.prompt.split("\n").filter((l) => l.includes("origin/master")).join("\n")}`);
  assert.match(land.prompt, /gh run list --branch blueprint-pro-master/);
  assert.match(land.prompt, /rebase origin\/blueprint-pro-master/);
  assert.match(
    land.prompt,
    /git-guard\.sh --dir=<worktree> --branch=devloop\/pitwall-maz --default=blueprint-pro-master -- git push/,
    "the land brief's own push is guarded without the configured base, so the guard would let a push onto it through",
  );
  const version = calls.find((c) => c.label.startsWith("version:"));
  assert.ok(version, "no version step ran");
  assert.equal(version.prompt.includes("origin/master"), false, "the version brief still names origin/master");
  assert.match(version.prompt, /git show origin\/blueprint-pro-master:/);
});

test("land-train.js and rework.js name the configured base rather than master", async () => {
  const train = runScript(
    "land-train.js",
    { ...ARGS, repo: "site", lockToken: "land-train-1-1" },
    (call: Call, n: number) => {
      if (n === 1) return { status: "taken", token: "land-train-1-1", holder: "land-train-1-1" };
      if (call.label.startsWith("build")) return { status: "empty", trainBranch: "", trainPr: 0, included: [], skipped: [], notes: "" };
      return { status: "released" };
    },
  );
  await train.done;
  const build = train.calls.find((c) => c.label.startsWith("build"));
  assert.ok(build, `no build step ran: ${train.calls.map((c) => c.label).join(", ")}`);
  assert.match(build.prompt, /land-train\.sh [^\n]* --base blueprint-pro-master/, "land-train.sh is not handed the configured base");
  assert.equal(build.prompt.includes("origin/master"), false, "the build brief still names origin/master");

  const rework = runScript(
    "rework.js",
    { ...ARGS, id: "pitwall-maz", pr: 80, repo: "site", slot: 1 },
    (call: Call, n: number) => {
      if (n === 1) return { status: "pushed", branch: PR.branch, oldHead: "aaaaaaa", newHead: "bbbbbbb", conflicts: [], notes: "" };
      return { status: "released" };
    },
  );
  await rework.done;
  const resolve = rework.calls[0];
  assert.ok(resolve, "no resolve step ran");
  assert.match(resolve.prompt, /merge --no-edit origin\/blueprint-pro-master/);
  assert.match(resolve.prompt, /lane-handoff\.sh [^\n]*--pre-push --branch <the branch> --base blueprint-pro-master/);
  assert.equal(resolve.prompt.includes("origin/master"), false, `the resolve brief still names origin/master:\n${resolve.prompt.split("\n").filter((l) => l.includes("origin/master")).join("\n")}`);
});
