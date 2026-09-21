import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };

function git(cwd: string, ...argv: string[]): string {
  const run = spawnGit(
    ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv],
    { cwd },
  );
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function write(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

const MASTER_GREEN = `echo '[{"status":"completed","conclusion":"success"}]'`;

function stubs(root: string, checkRuns: string, pull: string, runList = MASTER_GREEN): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  write(
    bin,
    "gh",
    `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"master"}}' ;;
  "run list")  ${runList} ;;
  "api "*/check-runs) ${checkRuns} ;;
  "api "*/pulls/*) ${pull} ;;
  *)           exit 0 ;;
esac
`,
  );
  write(
    bin,
    "git-guard",
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

function pull(head: string, labels = '[{"name":"lane-verified"}]'): string {
  return `echo '{"base":{"ref":"master"},"labels":${labels},"head":{"sha":"${head}"}}'`;
}

function checkRuns(runs: string): string {
  return `echo '{"total_count":1,"check_runs":${runs}}'`;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lander-rollup-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  write(repo, "README.md", "first\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  git(repo, "checkout", "--quiet", "-b", "devloop/zz-aaa1");
  write(repo, "fix.txt", "the change a lane made\n");
  git(repo, "add", "fix.txt");
  git(repo, "commit", "-m", "the change a lane made");
  git(repo, "push", "--quiet", "-u", "origin", "devloop/zz-aaa1");

  git(repo, "checkout", "--quiet", "master");
  return { root, bare, repo };
}

function run(root: string, repo: string, bin: string) {
  const ran = spawnSync(
    "bash",
    [
      join(SKILL, "land-one.sh"),
      "--repo-path",
      repo,
      "--slug",
      "acme/site",
      "--pr",
      "101",
      "--branch",
      "devloop/zz-aaa1",
      "--prefix",
      `landrollup-${process.pid}`,
      "--checks-wait",
      "0",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...GIT_ENV,
        HOME: root,
        LAND_ONE_REST_BACKOFF: "0",
      },
    },
  );
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

test("a rollup read that fails is reported as unread, not as a red pull request", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    "echo 'HTTP 403: API rate limit exceeded for installation (https://api.github.com/repos)' >&2; exit 1",
    pull(head),
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(
    ran.out,
    /^red:/m,
    "a rollup that could not be read at all is reported as a failing build, which sends whoever " +
      `reads this hunting a CI failure that does not exist:\n${ran.out}`,
  );
  assert.match(
    ran.out,
    /^unreadable:/m,
    `the output does not say the rollup could not be read:\n${ran.out}`,
  );
  assert.match(
    ran.out,
    new RegExp(`gh api repos/acme/site/commits/${head}/check-runs`),
    `the output does not name the read that was attempted:\n${ran.out}`,
  );
  assert.match(ran.out, /rate limit/, `the reason the read failed is nowhere in the output:\n${ran.out}`);
  assert.equal(ran.code, 9, `an unread rollup does not have its own exit status:\n${ran.out}\n${ran.err}`);
  assert.match(ran.err, /gh api repos\/acme\/site\/commits\/[0-9a-f]{40}\/check-runs .* was rate limited on attempt 1 of 5/, `a rate-limited read was not retried:\n${ran.err}`);
  assert.doesNotMatch(ran.err, /waiting [1-9]/, `the retry did not honour the configured backoff:\n${ran.err}`);
});

test("a rollup that is not the JSON it should be is reported as unread, not as a red pull request", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(box.root, "echo 'Gateway Timeout'", pull(head));

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^red:/m, `a rollup that did not parse is reported as red:\n${ran.out}`);
  assert.match(ran.out, /^unreadable:/m, `the output does not say the rollup could not be read:\n${ran.out}`);
  assert.match(ran.out, /check-runs/, `the output does not name the read that was attempted:\n${ran.out}`);
  assert.equal(ran.code, 9, `a rollup that did not parse does not exit 9:\n${ran.out}\n${ran.err}`);
});

test("a pull request read that fails after a green rollup is reported as unread, naming that read", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const once = join(box.root, "pulled-once");
  const bin = stubs(
    box.root,
    checkRuns('[{"name":"CI","status":"completed","conclusion":"success"}]'),
    `if [ -f ${JSON.stringify(once)} ]; then echo 'HTTP 403: API rate limit exceeded for installation (https://api.github.com/repos)' >&2; exit 1; fi; touch ${JSON.stringify(once)}; ${pull(head)}`,
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^ready:/m, `a pull request whose label could not be read was handed over for merging:\n${ran.out}`);
  assert.doesNotMatch(ran.out, /^red:/m, `an unreadable pull request is reported as red:\n${ran.out}`);
  assert.match(ran.out, /^unreadable:/m, `the output does not say the pull request could not be read:\n${ran.out}`);
  assert.match(ran.out, /gh api repos\/acme\/site\/pulls\/101/, `the output does not name the read that was attempted:\n${ran.out}`);
  assert.match(ran.out, /rate limit/, `the reason the read failed is nowhere in the output:\n${ran.out}`);
  assert.equal(ran.code, 9, `an unread pull request does not exit 9:\n${ran.out}\n${ran.err}`);
});

test("a check that genuinely failed is still red, named, and not merged", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    checkRuns('[{"name":"CI","status":"completed","conclusion":"failure"}]'),
    pull(head),
  );

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^red:/m, `a failing check is no longer reported as red:\n${ran.out}`);
  assert.match(ran.out, /CI/, `the red report does not name the check that failed:\n${ran.out}`);
  assert.equal(ran.code, 4, `a failing check no longer exits 4:\n${ran.out}\n${ran.err}`);
});

test("a check still in flight is not ready rather than red", () => {
  for (const run_ of ['{"name":"CI","status":"in_progress","conclusion":null}', '{"name":"CI","status":"queued","conclusion":""}']) {
    const box = workspace();
    const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
    const bin = stubs(box.root, checkRuns(`[${run_}]`), pull(head));

    const ran = run(box.root, box.repo, bin);

    assert.doesNotMatch(ran.out, /^red:/m, `a check that has not concluded is reported as red:\n${ran.out}`);
    assert.match(ran.out, /^not_ready: CI on 101 has not concluded/m, `a check that has not concluded is not reported as pending by name:\n${ran.out}`);
    assert.equal(ran.code, 7, `a pending check does not exit 7:\n${ran.out}\n${ran.err}`);
  }
});

test("an empty check-runs array is not ready, not green", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(box.root, `echo '{"total_count":0,"check_runs":[]}'`, pull(head));

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^ready:/m, `no checks at all was read as every check green:\n${ran.out}`);
  assert.match(ran.out, /^not_ready: rollup is empty on 101/m, `an empty rollup is not reported as empty:\n${ran.out}`);
  assert.equal(ran.code, 7, `an empty rollup does not exit 7:\n${ran.out}\n${ran.err}`);
});

test("check runs that all concluded success, neutral or skipped are green and ready to merge", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    checkRuns(
      '[{"name":"CI","status":"completed","conclusion":"success"},' +
        '{"name":"lint","status":"completed","conclusion":"neutral"},' +
        '{"name":"docs","status":"completed","conclusion":"skipped"}]',
    ),
    pull(head),
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /^unreadable:/m, `a REST check run is reported as a rollup that did not parse:\n${ran.out}`);
  assert.match(ran.out, /^ready:/m, `green check runs are not read as ready:\n${ran.out}`);
  assert.equal(ran.code, 0, `green check runs do not exit 0:\n${ran.out}\n${ran.err}`);
});

test("a check run that was cancelled or timed out is red and names the run", () => {
  for (const conclusion of ["cancelled", "timed_out", "action_required"]) {
    const box = workspace();
    const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
    const bin = stubs(
      box.root,
      checkRuns(
        '[{"name":"CI","status":"completed","conclusion":"success"},' +
          `{"name":"e2e","status":"completed","conclusion":"${conclusion}"}]`,
      ),
      pull(head),
    );

    const ran = run(box.root, box.repo, bin);

    assert.doesNotMatch(ran.out, /^not_ready:/m, `a ${conclusion} check run is deferred as pending:\n${ran.out}`);
    assert.match(ran.out, /^red: e2e failed/m, `a ${conclusion} check run is not red, or does not name the run:\n${ran.out}`);
    assert.equal(ran.code, 4, `a ${conclusion} check run does not exit 4:\n${ran.out}\n${ran.err}`);
  }
});

test("a rollup paged by gh is read across every page", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    `echo '[{"total_count":2,"check_runs":[{"name":"CI","status":"completed","conclusion":"success"}]},` +
      `{"total_count":2,"check_runs":[{"name":"e2e","status":"completed","conclusion":"failure"}]}]'`,
    pull(head),
  );

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^red: e2e failed/m, `a failure on the second page was not read:\n${ran.out}`);
  assert.equal(ran.code, 4, `${ran.out}\n${ran.err}`);
});

test("a pull request that no longer carries the label is not ready, even when the checks are green", () => {
  const box = workspace();
  const head = git(box.repo, "rev-parse", "refs/remotes/origin/devloop/zz-aaa1");
  const bin = stubs(
    box.root,
    checkRuns('[{"name":"CI","status":"completed","conclusion":"success"}]'),
    pull(head, '[{"name":"tooling"}]'),
  );

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^not_ready: 101 no longer carries lane-verified - labels are: tooling/m, ran.out);
  assert.equal(ran.code, 7, `${ran.out}\n${ran.err}`);
});

test("a pull request whose head is not the branch head is not ready", () => {
  const box = workspace();
  const bin = stubs(
    box.root,
    checkRuns('[{"name":"CI","status":"completed","conclusion":"success"}]'),
    pull("0123456789abcdef0123456789abcdef01234567"),
  );

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^not_ready: rollup describes 0123456789abcdef0123456789abcdef01234567 but the branch head is/m, ran.out);
  assert.equal(ran.code, 7, `${ran.out}\n${ran.err}`);
});

test("a master run list gh cannot answer is reported as unread, not as a red master", () => {
  const box = workspace();
  const bin = stubs(
    box.root,
    "exit 0",
    pull("unread"),
    "echo 'HTTP 403: API rate limit exceeded for installation (https://api.github.com/graphql)' >&2; exit 1",
  );

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(
    ran.out,
    /master_red/,
    "a run list that could not be read at all is reported as a red master, which skips every " +
      `pull request behind it and the deploy of anything already merged in the pass:\n${ran.out}`,
  );
  assert.match(ran.out, /^unreadable:/m, `the output does not say master's run could not be read:\n${ran.out}`);
  assert.match(
    ran.out,
    /gh run list --branch master/,
    `the output does not name the read that was attempted:\n${ran.out}`,
  );
  assert.match(ran.out, /rate limit/, `the reason the read failed is nowhere in the output:\n${ran.out}`);
  assert.equal(ran.code, 9, `an unread master run does not exit 9:\n${ran.out}\n${ran.err}`);
});

test("a master run list that is not the JSON it should be is reported as unread, not as a red master", () => {
  const box = workspace();
  const bin = stubs(box.root, "exit 0", pull("unread"), "echo 'Gateway Timeout'");

  const ran = run(box.root, box.repo, bin);

  assert.doesNotMatch(ran.out, /master_red/, `a run list that did not parse is reported as a red master:\n${ran.out}`);
  assert.match(ran.out, /^unreadable:/m, `the output does not say master's run could not be read:\n${ran.out}`);
  assert.equal(ran.code, 9, `a run list that did not parse does not exit 9:\n${ran.out}\n${ran.err}`);
});

test("a master run that was read and failed is still a red master", () => {
  const box = workspace();
  const bin = stubs(box.root, "exit 0", pull("unread"), `echo '[{"status":"completed","conclusion":"failure"}]'`);

  const ran = run(box.root, box.repo, bin);

  assert.match(ran.out, /^master_red: master is completed\/failure/m, `a failed master run is no longer reported as red:\n${ran.out}`);
  assert.doesNotMatch(ran.out, /^unreadable:/m, `a run that was read is reported as unread:\n${ran.out}`);
  assert.equal(ran.code, 5, `a red master no longer exits 5:\n${ran.out}\n${ran.err}`);
});
