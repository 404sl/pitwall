import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const AUTHOR = { name: "Release Author", email: "release@example.invalid" };

const MARKETPLACE = join(".claude-plugin", "marketplace.json");
const PLUGIN = join("plugins", "devloop", ".claude-plugin", "plugin.json");
const LOG = join("plugins", "devloop", "skills", "devloop", "CHANGELOG.md");
const SKILL_DOC = join("plugins", "devloop", "skills", "devloop", "SKILL.md");

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

function manifests(dir: string, version: string): void {
  write(
    dir,
    MARKETPLACE,
    `${JSON.stringify({ name: "pitwall", plugins: [{ name: "devloop", version, source: "./plugins/devloop" }] }, null, 2)}\n`,
  );
  write(dir, PLUGIN, `${JSON.stringify({ name: "devloop", version }, null, 2)}\n`);
}

function declared(bare: string, branch: string): { marketplace: string; plugin: string; log: string } {
  const show = (path: string): string => {
    const run = spawnGit(["--git-dir", bare, "show", `${branch}:${path}`]);
    assert.equal(run.status, 0, `git show ${branch}:${path} failed: ${run.stderr}`);
    return run.stdout || "";
  };
  const market = JSON.parse(show(MARKETPLACE)) as { plugins: { name: string; version: string }[] };
  const entry = market.plugins.find((p) => p.name === "devloop");
  assert.ok(entry, "the marketplace manifest lost its devloop entry");
  return {
    marketplace: entry.version,
    plugin: (JSON.parse(show(PLUGIN)) as { version: string }).version,
    log: show(LOG),
  };
}

function stubs(root: string, bare: string, body: string | null, perPr = false, queue = "[]"): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const titleBody =
    body === null
      ? "exit 1"
      : perPr
        ? `printf '%s\\n' '{"title":"Work the backlog","body":"Why this change.\\n\\n## Plugin changelog\\n\\nWhat pull request '"$3"' changed.\\n"}'`
        : `printf '%s\\n' ${JSON.stringify(body)}`;
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
case "$1 $2" in
  "run list")  echo '[{"status":"completed","conclusion":"success"}]' ;;
  "pr checks") exit 0 ;;
  "pr list")   printf '%s\\n' ${JSON.stringify(queue)} ;;
  "pr create") echo "https://github.com/acme/site/pull/200" ;;
  "pr view")
    case "$*" in
      *"title,body"*) ${titleBody} ;;
      *) echo '{"labels":[{"name":"lane-verified"}],"statusCheckRollup":[{"name":"CI","conclusion":"SUCCESS"}],"headRefOid":"'"$(git --git-dir=${JSON.stringify(bare)} rev-parse "refs/heads/$BRANCH_UNDER_TEST" 2>/dev/null)"'"}' ;;
    esac ;;
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

function workspace(version: string) {
  const root = mkdtempSync(join(tmpdir(), "lander-plugin-version-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", "--initial-branch=master", bare);
  git(root, "clone", "--quiet", bare, repo);
  manifests(repo, version);
  write(repo, LOG, `# Changelog\n\n## ${version}\n\nWhat the version before this one did.\n`);
  write(repo, SKILL_DOC, "How a session works the backlog.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the first commit");
  git(repo, "push", "--quiet", "origin", "master");

  return { root, bare, repo };
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

function landOne(root: string, repo: string, bin: string, branch: string, pr: string) {
  const ran = spawnSync(
    "bash",
    [
      join(SKILL, "land-one.sh"),
      "--repo-path",
      repo,
      "--slug",
      "acme/site",
      "--pr",
      pr,
      "--branch",
      branch,
      "--prefix",
      `landver-${process.pid}`,
    ],
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

const BODY = JSON.stringify({
  title: "Stop lanes choosing the plugin version",
  body: "Why this change.\n\n## Plugin changelog\n\nThe lander assigns the plugin version at merge time.\n",
});

test("land-one.sh assigns the plugin version to a branch that does not declare one", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY);
  lane(box.repo, "devloop/zz-plug1", SKILL_DOC, "How a session works the backlog, corrected.\n");

  const ran = landOne(box.root, box.repo, bin, "devloop/zz-plug1", "101");

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^version: assigned: devloop plugin version 0\.1\.34/m, ran.out);
  const on = declared(box.bare, "devloop/zz-plug1");
  assert.equal(on.marketplace, "0.1.34", `the marketplace manifest was not assigned a version: ${ran.out}`);
  assert.equal(on.plugin, "0.1.34", `the plugin manifest was not assigned a version: ${ran.out}`);
  assert.match(on.log, /## 0\.1\.34\n\nThe lander assigns the plugin version at merge time\./);
});

test("two plugin branches in one pass are both ready to merge, with consecutive versions", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY);
  lane(box.repo, "devloop/zz-plug1", SKILL_DOC, "First change.\n");
  lane(box.repo, "devloop/zz-plug2", join("plugins", "devloop", "README.md"), "What the plugin is.\n");

  const first = landOne(box.root, box.repo, bin, "devloop/zz-plug1", "101");
  assert.equal(first.code, 0, `${first.out}\n${first.err}`);
  assert.equal(declared(box.bare, "devloop/zz-plug1").plugin, "0.1.34", first.out);

  git(box.repo, "fetch", "--quiet", "origin");
  git(box.repo, "checkout", "--quiet", "master");
  git(box.repo, "merge", "--quiet", "--ff-only", "origin/devloop/zz-plug1");
  git(box.repo, "push", "--quiet", "origin", "master");

  const second = landOne(box.root, box.repo, bin, "devloop/zz-plug2", "102");
  assert.equal(
    second.code,
    0,
    "the second plugin branch of the pass was not landable. Before the lander assigned the number, " +
      "both branches read the same master and declared the same version, so the guard refused every " +
      `one after the first and they were retired:\n${second.out}\n${second.err}`,
  );
  const on = declared(box.bare, "devloop/zz-plug2");
  assert.equal(on.plugin, "0.1.35", `the second branch did not get the number after the first: ${second.out}`);
  assert.equal(on.marketplace, "0.1.35", `the two manifests disagree, which breaks the marketplace install: ${second.out}`);
  assert.match(on.log, /## 0\.1\.35/);
  assert.match(on.log, /## 0\.1\.34/);
});

test("land-one.sh does not push a branch that needs neither a rebase nor a version", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY);
  lane(box.repo, "devloop/zz-src", join("src", "board.ts"), "export const x = 1;\n");
  const head = git(box.repo, "rev-parse", "origin/devloop/zz-src");

  const ran = landOne(box.root, box.repo, bin, "devloop/zz-src", "103");

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^current:/m, ran.out);
  assert.equal(
    git(box.repo, "rev-parse", "origin/devloop/zz-src"),
    head,
    "a branch with nothing to rebase and no plugin file was pushed again, which starts a second CI run for nothing",
  );
});

function versionCommits(repo: string, branch: string): string[] {
  return git(repo, "log", "--format=%s", `origin/master..origin/${branch}`)
    .split("\n")
    .filter((line) => line.startsWith("Set devloop plugin version "));
}

test("land-one.sh run twice on one plugin branch leaves one version commit and pushes nothing the second time", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY);
  lane(box.repo, "devloop/zz-twice", SKILL_DOC, "Changed once.\n");

  const first = landOne(box.root, box.repo, bin, "devloop/zz-twice", "104");
  assert.equal(first.code, 0, `${first.out}\n${first.err}`);
  git(box.repo, "fetch", "--quiet", "origin");
  const head = git(box.repo, "rev-parse", "origin/devloop/zz-twice");
  assert.equal(declared(box.bare, "devloop/zz-twice").plugin, "0.1.34", first.out);

  const second = landOne(box.root, box.repo, bin, "devloop/zz-twice", "104");

  assert.equal(
    second.code,
    0,
    "a plugin pull request that did not merge in the round that prepared it came back blocked. " +
      "land.js re-invokes land-one.sh on every pull request it deferred - an empty rollup is a " +
      `normal, expected case - so a blocked second round blocks it on every later round too:\n${second.out}\n${second.err}`,
  );
  git(box.repo, "fetch", "--quiet", "origin");
  assert.equal(
    git(box.repo, "rev-parse", "origin/devloop/zz-twice"),
    head,
    "the second round force-pushed an identical tree, which restarts CI and defers the pull request again",
  );
  const on = declared(box.bare, "devloop/zz-twice");
  assert.equal(on.plugin, "0.1.34", `the second round moved the number: ${second.out}`);
  assert.equal(on.marketplace, "0.1.34", second.out);
  assert.equal(
    versionCommits(box.repo, "devloop/zz-twice").length,
    1,
    `the second round stacked another version commit on the branch: ${second.out}`,
  );
  assert.equal(on.log.match(/## 0\.1\.34/g)?.length, 1, `the changelog gained the same version twice: ${on.log}`);
});

test("a plugin branch deferred past another landing is assigned the new next version instead of conflicting", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY, true);
  lane(box.repo, "devloop/zz-early", SKILL_DOC, "The branch that waits.\n");
  lane(box.repo, "devloop/zz-late", join("plugins", "devloop", "README.md"), "What the plugin is.\n");

  assert.equal(landOne(box.root, box.repo, bin, "devloop/zz-early", "105").code, 0);
  assert.equal(declared(box.bare, "devloop/zz-early").plugin, "0.1.34");

  const late = landOne(box.root, box.repo, bin, "devloop/zz-late", "106");
  assert.equal(late.code, 0, `${late.out}\n${late.err}`);
  git(box.repo, "fetch", "--quiet", "origin");
  git(box.repo, "checkout", "--quiet", "master");
  git(box.repo, "merge", "--quiet", "--ff-only", "origin/devloop/zz-late");
  git(box.repo, "push", "--quiet", "origin", "master");

  const again = landOne(box.root, box.repo, bin, "devloop/zz-early", "105");

  assert.equal(
    again.code,
    0,
    "the version commit an earlier round wrote was replayed by the rebase onto a master whose " +
      "own number had moved, so a green plugin pull request conflicted on the changelog and was " +
      `retired - the exact cost this exists to remove:\n${again.out}\n${again.err}`,
  );
  git(box.repo, "fetch", "--quiet", "origin");
  const on = declared(box.bare, "devloop/zz-early");
  assert.equal(on.plugin, "0.1.35", `it did not take the number after master's: ${again.out}`);
  assert.equal(on.marketplace, "0.1.35", `the two manifests disagree, which breaks the marketplace install: ${again.out}`);
  assert.equal(
    versionCommits(box.repo, "devloop/zz-early").length,
    1,
    `the branch carries more than one version commit: ${again.out}`,
  );
  assert.equal(on.log.match(/## 0\.1\.34/g)?.length, 1, `0.1.34 is in the changelog twice: ${on.log}`);
  assert.match(on.log, /## 0\.1\.35/);
});

test("a plugin branch whose changelog text cannot be read is refused rather than assigned an empty entry", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, null);
  lane(box.repo, "devloop/zz-unread", SKILL_DOC, "Changed, with the body unreadable.\n");
  const head = git(box.repo, "rev-parse", "origin/devloop/zz-unread");

  const ran = landOne(box.root, box.repo, bin, "devloop/zz-unread", "107");

  assert.equal(
    ran.code,
    6,
    "a round that could not read the pull request body reported the version as assigned anyway. " +
      "Both callers print only the first line of the assignment's output, so a warning about an " +
      `empty entry never reaches the run log:\n${ran.out}\n${ran.err}`,
  );
  assert.match(
    ran.out,
    /^usage: the devloop plugin version could not be assigned for devloop\/zz-unread - refused: no changelog text could be read for pull request #107/m,
    ran.out,
  );
  assert.doesNotMatch(ran.out, /^version: assigned/m, `the round reported a version it did not write:\n${ran.out}`);
  git(box.repo, "fetch", "--quiet", "origin");
  assert.equal(
    git(box.repo, "rev-parse", "origin/devloop/zz-unread"),
    head,
    "the branch was pushed with a version whose changelog entry is empty",
  );
  const on = declared(box.bare, "devloop/zz-unread");
  assert.equal(on.plugin, "0.1.33", `the version moved with nothing to say for it: ${ran.out}`);
  assert.doesNotMatch(on.log, /## 0\.1\.34/, `the changelog gained a heading with nothing under it: ${on.log}`);
});

function landTrain(root: string, repo: string, bin: string, prefix: string) {
  const ran = spawnSync(
    "bash",
    [join(SKILL, "land-train.sh"), "--repo-path", repo, "--slug", "acme/site", "--prefix", prefix],
    {
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
      },
    },
  );
  return { code: ran.status, out: ran.stdout || "", err: ran.stderr || "" };
}

function trainOn(bare: string): string {
  const run = spawnGit(["--git-dir", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/release/*"]);
  return (run.stdout || "").trim();
}

function queued(entries: [number, string, string][]): string {
  return JSON.stringify(
    entries.map(([number, branch, title], i) => ({
      number,
      title,
      headRefName: branch,
      createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    })),
  );
}

test("a train carrying two plugin changes is assigned one version, and every candidate's entry is under it", () => {
  const box = workspace("0.1.33");
  const bin = stubs(
    box.root,
    box.bare,
    BODY,
    true,
    queued([
      [201, "devloop/zz-train1", "First plugin change"],
      [202, "devloop/zz-train2", "Second plugin change"],
    ]),
  );
  lane(box.repo, "devloop/zz-train1", SKILL_DOC, "First change.\n");
  lane(box.repo, "devloop/zz-train2", join("plugins", "devloop", "README.md"), "What the plugin is.\n");

  const ran = landTrain(box.root, box.repo, bin, `trainver-${process.pid}`);

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^version: assigned: devloop plugin version 0\.1\.34/m, ran.out);
  const train = trainOn(box.bare);
  assert.notEqual(train, "", `no release branch reached the remote:\n${ran.out}`);
  const on = declared(box.bare, train);
  assert.equal(on.plugin, "0.1.34", `the train did not declare master's next version: ${ran.out}`);
  assert.equal(on.marketplace, "0.1.34", `the two manifests disagree, which breaks the marketplace install: ${ran.out}`);
  assert.match(on.log, /## 0\.1\.34/);
  assert.match(on.log, /What pull request 201 changed\./, `#201 has no changelog entry: ${on.log}`);
  assert.match(on.log, /What pull request 202 changed\./, `#202 has no changelog entry: ${on.log}`);
  assert.match(ran.out, /^PR=200$/m, ran.out);
});

test("a train whose version cannot be assigned names the plugin changes that lost the pass", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY, true, queued([[203, "devloop/zz-train3", "Describe the plugin"]]));
  lane(
    box.repo,
    "devloop/zz-train3",
    PLUGIN,
    `${JSON.stringify({ name: "devloop", version: "0.1.33", description: "What the plugin is for." }, null, 2)}\n`,
  );

  const ran = landTrain(box.root, box.repo, bin, `trainref-${process.pid}`);

  assert.equal(ran.code, 6, `a manifest edit the assignment refuses did not stop the train:\n${ran.out}\n${ran.err}`);
  assert.match(
    ran.out,
    /^usage: the devloop plugin version could not be assigned to release\/\S+, whose plugin change\(s\) are #203 - refused: /m,
    "the refusal does not say which candidate to look at, and up to eight green pull requests lose " +
      `the pass with it:\n${ran.out}`,
  );
  assert.equal(trainOn(box.bare), "", `the refused train was left on the remote:\n${ran.out}`);
});

function versionOnly(repo: string, branch: string, version: string): void {
  git(repo, "checkout", "--quiet", "master");
  git(repo, "checkout", "--quiet", "-b", branch);
  manifests(repo, version);
  const log = readFileSync(join(repo, LOG), "utf8");
  write(repo, LOG, log.replace("# Changelog\n", `# Changelog\n\n## ${version}\n\nWhat this one would say.\n`));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `Set devloop plugin version ${version}`);
  git(repo, "push", "--quiet", "-u", "origin", branch);
  git(repo, "checkout", "--quiet", "master");
}

test("a branch still carrying a version commit an earlier round wrote goes on the train rather than being skipped", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY, true, queued([[204, "devloop/zz-carried", "The change that waited"]]));
  lane(box.repo, "devloop/zz-carried", SKILL_DOC, "The change that waited.\n");
  lane(box.repo, "devloop/zz-ahead", join("plugins", "devloop", "README.md"), "What the plugin is.\n");

  assert.equal(landOne(box.root, box.repo, bin, "devloop/zz-carried", "204").code, 0);
  assert.equal(declared(box.bare, "devloop/zz-carried").plugin, "0.1.34");
  assert.equal(landOne(box.root, box.repo, bin, "devloop/zz-ahead", "205").code, 0);
  git(box.repo, "fetch", "--quiet", "origin");
  git(box.repo, "checkout", "--quiet", "master");
  git(box.repo, "merge", "--quiet", "--ff-only", "origin/devloop/zz-ahead");
  git(box.repo, "push", "--quiet", "origin", "master");
  assert.equal(declared(box.bare, "master").plugin, "0.1.34");

  const ran = landTrain(box.root, box.repo, bin, `traincarry-${process.pid}`);

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.doesNotMatch(
    ran.out,
    /skipped #204/,
    "the branch was dropped from the train for conflicting on the changelog. The version commit " +
      "is not the lane's - an earlier round wrote it and force-pushed it - so the branch replays " +
      "an entry under a version master has since used, and a skip costs the whole pass for work " +
      `that was green:\n${ran.out}`,
  );
  assert.match(ran.out, /^ {2}added {3}#204 devloop\/zz-carried/m, ran.out);
  const train = trainOn(box.bare);
  assert.notEqual(train, "", `no release branch reached the remote:\n${ran.out}`);
  const on = declared(box.bare, train);
  assert.equal(on.plugin, "0.1.35", `the train did not take the number after master's: ${ran.out}`);
  assert.equal(on.marketplace, "0.1.35", `the two manifests disagree, which breaks the marketplace install: ${ran.out}`);
  assert.equal(on.log.match(/## 0\.1\.34/g)?.length, 1, `0.1.34 is named twice in the train changelog: ${on.log}`);
  assert.equal(on.log.match(/## 0\.1\.35/g)?.length, 1, `0.1.35 is not named exactly once: ${on.log}`);
  assert.match(on.log, /What pull request 204 changed\./, `#204 has no changelog entry: ${on.log}`);
});

test("a branch whose only commit is a version commit is still carried by the train", () => {
  const box = workspace("0.1.33");
  const bin = stubs(box.root, box.bare, BODY, true, queued([[206, "devloop/zz-onlyver", "Only a version"]]));
  versionOnly(box.repo, "devloop/zz-onlyver", "0.1.34");

  const ran = landTrain(box.root, box.repo, bin, `trainonly-${process.pid}`);

  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(
    ran.out,
    /^ {2}added {3}#206 devloop\/zz-onlyver/m,
    "dropping the version commit emptied the branch, so the train carried nothing of it and the " +
      `pull request stayed open looking unlanded:\n${ran.out}`,
  );
  assert.doesNotMatch(ran.out, /skipped #206/, ran.out);
  const train = trainOn(box.bare);
  assert.notEqual(train, "", `no release branch reached the remote:\n${ran.out}`);
  const on = declared(box.bare, train);
  assert.equal(on.plugin, "0.1.34", `the train does not declare master's next version: ${ran.out}`);
  assert.equal(on.log.match(/## 0\.1\.34/g)?.length, 1, `0.1.34 is named twice in the train changelog: ${on.log}`);
});
