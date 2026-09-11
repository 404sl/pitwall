import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };

function git(cwd: string, ...argv: string[]): string {
  const run = spawnSync(
    "git",
    ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, ...argv],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  assert.equal(run.status, 0, `git ${argv.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return (run.stdout || "").trim();
}

function write(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

function stubs(root: string, bare: string, queue: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  write(
    bin,
    "gh",
    `#!/bin/bash
case "$1 $2" in
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr list")   cat ${JSON.stringify(join(root, "queue.json"))} ;;
  "pr create") echo "https://github.com/acme/site/pull/200" ;;
  "pr view")   echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"SUCCESS"}],"headRefOid":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse refs/heads/devloop/zz-aaa1 2>/dev/null)"'"}' ;;
  "pr checks") exit 0 ;;
  *)           exit 0 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  write(root, "queue.json", queue);
  return bin;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lander-identity-"));
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
  const branchHead = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "--quiet", "master");
  write(repo, "README.md", "first\nsomething else landed\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "something else landed");
  git(repo, "push", "--quiet", "origin", "master");

  return { root, bare, repo, branchHead };
}

function skillWith(root: string, tag: string, guard: string | null): string {
  const skill = join(root, `skill-${tag}`);
  mkdirSync(skill);
  for (const entry of readdirSync(SKILL)) symlinkSync(join(SKILL, entry), join(skill, entry));
  unlinkSync(join(skill, "git-guard.sh"));
  if (guard !== null) {
    writeFileSync(join(skill, "git-guard.sh"), guard);
    chmodSync(join(skill, "git-guard.sh"), 0o755);
  }
  return skill;
}

const REFUSING_GUARD = `#!/bin/bash
echo "REFUSED" >&2
echo "git-guard.sh: /nowhere is on release/other and the caller believes it is on what it named." >&2
echo "              Nothing was run." >&2
exit 2
`;

function run(script: string, argv: string[], root: string, bin: string, skill: string = SKILL) {
  const ran = spawnSync("bash", [join(skill, script), ...argv], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
      HOME: root,
    },
  });
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

test("a train commits with the identity master already carries, not with one from a home config", () => {
  const box = workspace();
  const bin = stubs(
    box.root,
    box.bare,
    JSON.stringify([
      {
        number: 101,
        title: "the change a lane made",
        headRefName: "devloop/zz-aaa1",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
  );

  const ran = run(
    "land-train.sh",
    ["--repo-path", box.repo, "--slug", "acme/site", "--prefix", `landid-${process.pid}`],
    box.root,
    bin,
  );

  assert.equal(
    ran.code,
    0,
    "the train did not build. With no identity to read, git refuses the squash merge and the commit " +
      "after it, and the script reports those as a conflict and as 'commit refused' - so every " +
      `candidate is dropped and the train comes out empty:\n${ran.out}\n${ran.err}`,
  );
  assert.match(ran.out, /added {3}#101/, `#101 was not added to the train:\n${ran.out}`);

  const train = git(box.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/release/*");
  assert.notEqual(train, "", "no release branch reached the remote");
  assert.equal(
    git(box.bare, "log", "-1", "--format=%an <%ae>", train),
    `${AUTHOR.name} <${AUTHOR.email}>`,
    "the train commit does not carry the author master already carries. With no identity passed " +
      "to it, git either refuses the commit or invents one from the machine account, and the " +
      "second is the dangerous half: the commit lands, under a name that belongs to nobody",
  );
});

test("a rebase with no identity to borrow is not reported as a conflict with master", () => {
  const box = workspace();
  const bin = stubs(box.root, box.bare, "[]");

  const ran = run(
    "land-one.sh",
    [
      "--repo-path",
      box.repo,
      "--slug",
      "acme/site",
      "--pr",
      "101",
      "--branch",
      "devloop/zz-aaa1",
      "--prefix",
      `landid-one-${process.pid}`,
    ],
    box.root,
    bin,
  );

  assert.doesNotMatch(
    ran.out,
    /^conflict:/m,
    "a rebase that fails for want of an identity is reported as a conflict with master, which " +
      `sends a branch back to a person for a reason that is not true:\n${ran.out}`,
  );
  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^rebased: devloop\/zz-aaa1 was 1 behind, rebased and pushed$/m, ran.out);
  assert.equal(
    git(box.bare, "log", "-1", "--format=%cn <%ce>", "devloop/zz-aaa1"),
    `${AUTHOR.name} <${AUTHOR.email}>`,
    "the rebase rewrote the committer as whatever git could invent from the machine account",
  );
});

test("a guard that cannot be executed is not reported as a push the guard refused", () => {
  const box = workspace();
  const bin = stubs(
    box.root,
    box.bare,
    JSON.stringify([
      {
        number: 101,
        title: "the change a lane made",
        headRefName: "devloop/zz-aaa1",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
  );
  const skill = skillWith(box.root, "absent", null);

  const ran = run(
    "land-train.sh",
    ["--repo-path", box.repo, "--slug", "acme/site", "--prefix", `guardless-${process.pid}`],
    box.root,
    bin,
    skill,
  );

  assert.equal(ran.code, 6, `${ran.out}\n${ran.err}`);
  assert.doesNotMatch(
    ran.out,
    /refused/,
    "a guard that was never executed is reported as a guard that refused the push. That is the " +
      "misdiagnosis loop this guard was written to end: the lander says the invariant stopped " +
      `the push, and a person re-reads the branch looking for a reason that is not there:\n${ran.out}`,
  );
  assert.match(
    ran.out,
    /could not be run/,
    `the summary does not say the guard itself is the problem:\n${ran.out}`,
  );
});

test("a guard that refuses says on the summary line why it refused", () => {
  const box = workspace();
  const bin = stubs(
    box.root,
    box.bare,
    JSON.stringify([
      {
        number: 101,
        title: "the change a lane made",
        headRefName: "devloop/zz-aaa1",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
  );
  const skill = skillWith(box.root, "refusing", REFUSING_GUARD);

  const ran = run(
    "land-train.sh",
    ["--repo-path", box.repo, "--slug", "acme/site", "--prefix", `guardno-${process.pid}`],
    box.root,
    bin,
    skill,
  );

  assert.equal(ran.code, 6, `${ran.out}\n${ran.err}`);
  assert.match(
    ran.out,
    /git-guard\.sh: .*release\/other/,
    "the guard explained itself and the lander threw the explanation away, so the summary names " +
      `no cause a person can act on:\n${ran.out}`,
  );
});

test("land-one.sh tells a guard it could not run apart from one that refused", () => {
  const absent = workspace();
  const gone = run(
    "land-one.sh",
    [
      "--repo-path",
      absent.repo,
      "--slug",
      "acme/site",
      "--pr",
      "101",
      "--branch",
      "devloop/zz-aaa1",
      "--prefix",
      `oneguardless-${process.pid}`,
    ],
    absent.root,
    stubs(absent.root, absent.bare, "[]"),
    skillWith(absent.root, "absent", null),
  );

  assert.equal(gone.code, 6, `${gone.out}\n${gone.err}`);
  assert.doesNotMatch(
    gone.out,
    /refused/,
    `a guard that never ran is reported as a refusal of the force-push:\n${gone.out}`,
  );
  assert.match(gone.out, /could not be run/, `${gone.out}`);

  const box = workspace();
  const no = run(
    "land-one.sh",
    [
      "--repo-path",
      box.repo,
      "--slug",
      "acme/site",
      "--pr",
      "101",
      "--branch",
      "devloop/zz-aaa1",
      "--prefix",
      `oneguardno-${process.pid}`,
    ],
    box.root,
    stubs(box.root, box.bare, "[]"),
    skillWith(box.root, "refusing", REFUSING_GUARD),
  );

  assert.equal(no.code, 6, `${no.out}\n${no.err}`);
  assert.match(
    no.out,
    /git-guard\.sh: .*release\/other/,
    `the refusal reason the guard printed is missing from the summary:\n${no.out}`,
  );
});
