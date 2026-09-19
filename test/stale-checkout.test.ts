import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOCK_ROOT, slotsPath } from "../src/lanes.ts";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const CONFIG_SH = join(SKILL, "config.sh");
const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

let sequence = 0;

interface Box {
  root: string;
  bin: string;
  config: string;
  prefix: string;
  checkout: string;
  pusher: string;
}

function git(cwd: string, ...args: string[]): string {
  const ran = spawnGit([...IDENTITY, ...args], { cwd });
  assert.equal(ran.status, 0, `git ${args.join(" ")} in ${cwd}:\n${ran.stderr}`);
  return ran.stdout.trim();
}

function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
}

function workspace(extra: Record<string, unknown> = {}, branch = "master"): Box {
  const root = mkdtempSync(join(tmpdir(), "pitwall-stale-checkout-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", branch, origin);
  const pusher = join(root, "pusher");
  git(root, "clone", "-q", origin, pusher);
  git(pusher, "checkout", "-q", "-b", branch);
  commit(pusher, "first");
  git(pusher, "push", "-q", "origin", branch);
  const checkout = join(root, "repo");
  git(root, "clone", "-q", origin, checkout);
  const prefix = `pwstale${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  const repo: Record<string, unknown> = { path: "repo", test: "npm test", slug: "acme/site" };
  if (branch !== "master") repo["defaultBranch"] = branch;
  writeFileSync(config, JSON.stringify({ root, idPrefix: "zz", lockPrefix: prefix, lanes: 2, repos: { site: repo }, ...extra }));
  writeFileSync(join(bin, "bd"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "bd"), 0o755);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash\ncase "$1 $2" in\n  "repo view") echo '{"defaultBranchRef":{"name":"${branch}"}}' ;;\n  *) exit 0 ;;\nesac\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { root, bin, config, prefix, checkout, pusher };
}

function clean(box: Box): void {
  rmSync(slotsPath(box.prefix), { recursive: true, force: true });
  for (let lane = 1; lane <= 9; lane += 1) {
    rmSync(join(LOCK_ROOT, `${box.prefix}-lane-${lane}.lock`), { recursive: true, force: true });
  }
  rmSync(box.root, { recursive: true, force: true });
}

function config(box: Box, ...argv: string[]) {
  const ran = spawnSync("bash", [CONFIG_SH, ...argv], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function ahead(box: Box, count: number, branch = "master"): string {
  for (let n = 1; n <= count; n += 1) commit(box.pusher, `later-${sequence}-${n}`);
  git(box.pusher, "push", "-q", "origin", branch);
  return git(box.pusher, "rev-parse", "--short", "HEAD");
}

test("a checkout behind origin by more than warnBehind is named at dispatch, with the count and both shas, and the dispatch proceeds", () => {
  const box = workspace({ warnBehind: 2 });
  try {
    const local = git(box.checkout, "rev-parse", "--short", "HEAD");
    const remote = ahead(box, 3);
    for (const mode of [["--args", "zz-aaa1"], ["--rework", "zz-aaa2", "7", "site"]]) {
      const ran = config(box, ...mode);
      assert.equal(ran.status, 0, `${mode.join(" ")} stopped on a stale checkout:\n${ran.stderr}`);
      assert.doesNotThrow(() => JSON.parse(ran.stdout), `${mode.join(" ")} did not print an args object`);
      assert.match(ran.stderr, /site \(repo\) master is 3 behind origin\/master/, `${mode.join(" ")}:\n${ran.stderr}`);
      assert.match(ran.stderr, new RegExp(`${local} local, ${remote} origin`), `${mode.join(" ")} did not name both shas:\n${ran.stderr}`);
      assert.equal(git(box.checkout, "rev-parse", "--short", "HEAD"), local, `${mode.join(" ")} moved the checkout`);
    }
  } finally {
    clean(box);
  }
});

test("a checkout behind by exactly warnBehind is not mentioned", () => {
  const box = workspace({ warnBehind: 2 });
  try {
    ahead(box, 2);
    const ran = config(box, "--args", "zz-aaa1");
    assert.equal(ran.status, 0, ran.stderr);
    assert.doesNotMatch(ran.stderr, /behind origin/, ran.stderr);
    assert.doesNotMatch(ran.stderr, /could not be compared/, ran.stderr);
  } finally {
    clean(box);
  }
});

test("without warnBehind any lag at all is reported, and an up-to-date checkout is silent", () => {
  const box = workspace();
  try {
    const fresh = config(box, "--args", "zz-aaa1");
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stderr, /behind origin|could not be compared/, fresh.stderr);

    ahead(box, 1);
    const stale = config(box, "--args", "zz-aaa2");
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stderr, /site \(repo\) master is 1 behind origin\/master/, stale.stderr);
  } finally {
    clean(box);
  }
});

test("the comparison follows the configured default branch, not master", () => {
  const box = workspace({}, "main");
  try {
    ahead(box, 1, "main");
    const ran = config(box, "--args", "zz-aaa1");
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stderr, /site \(repo\) main is 1 behind origin\/main/, ran.stderr);
    assert.doesNotMatch(ran.stderr, /origin\/master/, ran.stderr);
  } finally {
    clean(box);
  }
});

test("a fetch that fails is reported as not compared, never as up to date, and the dispatch still proceeds", () => {
  const box = workspace();
  try {
    ahead(box, 5);
    git(box.checkout, "remote", "set-url", "origin", join(box.root, "gone.git"));
    const ran = config(box, "--args", "zz-aaa1");
    assert.equal(ran.status, 0, `a failed fetch stopped the dispatch:\n${ran.stderr}`);
    assert.doesNotThrow(() => JSON.parse(ran.stdout));
    assert.match(ran.stderr, /site \(repo\) master could not be compared with origin\/master - fetch exited/, ran.stderr);
    assert.doesNotMatch(ran.stderr, /behind origin/, ran.stderr);
  } finally {
    clean(box);
  }
});
