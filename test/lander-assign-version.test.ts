import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GIT_ENV, spawnGit } from "./support/git.js";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "assign-plugin-version.sh",
);

const MARKETPLACE = join(".claude-plugin", "marketplace.json");
const PLUGIN = join("plugins", "devloop", ".claude-plugin", "plugin.json");
const LOG = join("plugins", "devloop", "skills", "devloop", "CHANGELOG.md");
const SKILL = join("plugins", "devloop", "skills", "devloop", "SKILL.md");

interface Repo {
  dir: string;
  bin: string;
}

function git(dir: string, ...args: string[]): string {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return (ran.stdout ?? "").trim();
}

function write(repo: string, relative: string, body: string): void {
  const path = join(repo, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function read(repo: string, relative: string): string {
  return readFileSync(join(repo, relative), "utf8");
}

function versions(repo: string): { marketplace: string; plugin: string } {
  const market = JSON.parse(read(repo, MARKETPLACE)) as { plugins: { name: string; version: string }[] };
  const entry = market.plugins.find((p) => p.name === "devloop");
  assert.ok(entry, "the fixture lost its devloop entry");
  return { marketplace: entry.version, plugin: (JSON.parse(read(repo, PLUGIN)) as { version: string }).version };
}

function manifests(repo: string, version: string): void {
  write(
    repo,
    MARKETPLACE,
    `${JSON.stringify({ name: "pitwall", plugins: [{ name: "devloop", version, source: "./plugins/devloop" }] }, null, 2)}\n`,
  );
  write(repo, PLUGIN, `${JSON.stringify({ name: "devloop", version }, null, 2)}\n`);
}

function repoAt(version: string, options: { body?: string; title?: string; unreadable?: string[] } = {}): Repo {
  const root = mkdtempSync(join(tmpdir(), "pitwall-assign-"));
  const dir = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(dir);
  mkdirSync(bin);

  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "nobody@example.invalid");
  git(dir, "config", "user.name", "Nobody");
  manifests(dir, version);
  write(dir, LOG, `# Changelog\n\n## ${version}\n\nWhat the version before this one did.\n`);
  write(dir, SKILL, "How a session works the backlog.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/master", git(dir, "rev-parse", "HEAD"));

  const script = [
    "#!/bin/sh",
    `unreadable="${(options.unreadable ?? []).join(" ")}"`,
    'case "$*" in',
    '  *"--json title,body"*)',
    '    for bad in $unreadable; do [ "$3" = "$bad" ] && exit 1; done',
    `    printf '%s\\n' '${JSON.stringify({
      title: options.title ?? "Report whether an open pull request is still a draft",
      body: options.body ?? "",
    })}' ;;`,
    "  *) exit 1 ;;",
    "esac",
  ].join("\n");
  writeFileSync(join(bin, "gh"), `${script}\n`);
  chmodSync(join(bin, "gh"), 0o755);

  return { dir, bin };
}

function branch(repo: Repo, name: string, touch: () => void, message = "Work on the skill"): void {
  git(repo.dir, "checkout", "--quiet", "-b", name, "refs/remotes/origin/master");
  touch();
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "--quiet", "-m", message);
}

function assign(repo: Repo, args: string[] = []): { status: number; out: string } {
  const ran = spawnSync("bash", [SCRIPT, "--worktree", repo.dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, PATH: `${repo.bin}:${process.env.PATH ?? ""}` },
  });
  return { status: ran.status ?? -1, out: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
}

function entryFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pitwall-entry-")), "entry.md");
  writeFileSync(path, `${text}\n`);
  return path;
}

test("the lander assigns master's next version, and all three files name it", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/pitwall-znlr", () => write(repo.dir, SKILL, "How a session works the backlog, corrected.\n"));

  const ran = assign(repo, ["--entry-file", entryFile("A lane no longer picks the plugin version.")]);
  assert.equal(ran.status, 0, ran.out);

  assert.deepEqual(versions(repo.dir), { marketplace: "0.1.34", plugin: "0.1.34" });
  const log = read(repo.dir, LOG);
  assert.match(log, /^# Changelog\n\n## 0\.1\.34\n\nA lane no longer picks the plugin version\./);
  assert.match(log, /## 0\.1\.33/);
  assert.match(git(repo.dir, "log", "-1", "--format=%s"), /0\.1\.34/);
});

test("two plugin branches landing in one pass get consecutive versions", () => {
  const repo = repoAt("0.1.33");
  const cut = git(repo.dir, "rev-parse", "refs/remotes/origin/master");

  branch(repo, "devloop/first", () => write(repo.dir, SKILL, "First change.\n"));
  assert.equal(assign(repo, ["--entry-file", entryFile("The first change.")]).status, 0);
  const first = git(repo.dir, "rev-parse", "HEAD");
  git(repo.dir, "update-ref", "refs/remotes/origin/master", first);

  git(repo.dir, "checkout", "--quiet", "-b", "devloop/second", cut);
  write(repo.dir, join("plugins", "devloop", "README.md"), "What the plugin is.\n");
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "--quiet", "-m", "Second change");
  git(repo.dir, "rebase", "--quiet", "refs/remotes/origin/master");

  const second = assign(repo, ["--entry-file", entryFile("The second change.")]);
  assert.equal(
    second.status,
    0,
    `the second plugin branch of the pass was refused, which is the deadlock this exists to remove: ${second.out}`,
  );
  assert.deepEqual(
    versions(repo.dir),
    { marketplace: "0.1.35", plugin: "0.1.35" },
    "the second branch of the pass did not get the number after the first",
  );
  const log = read(repo.dir, LOG);
  assert.match(log, /## 0\.1\.35\n\nThe second change\./);
  assert.match(log, /## 0\.1\.34\n\nThe first change\./);
});

test("a branch that chose its own version has it overwritten with master's next, not incremented from its own", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/stale", () => {
    write(repo.dir, SKILL, "Changed.\n");
    manifests(repo.dir, "0.1.30");
    write(repo.dir, LOG, "# Changelog\n\n## 0.1.30\n\nWhat this branch guessed.\n");
  });

  assert.equal(assign(repo, ["--entry-file", entryFile("What it actually did.")]).status, 0);
  assert.deepEqual(versions(repo.dir), { marketplace: "0.1.34", plugin: "0.1.34" });
  const log = read(repo.dir, LOG);
  assert.doesNotMatch(log, /0\.1\.31/);
  assert.doesNotMatch(log, /What this branch guessed/);
  assert.match(log, /## 0\.1\.34\n\nWhat it actually did\./);
  assert.match(log, /## 0\.1\.33/);
});

test("the number is compared as three numbers, so 0.1.9 becomes 0.1.10", () => {
  const repo = repoAt("0.1.9");
  branch(repo, "devloop/ninth", () => write(repo.dir, SKILL, "Changed.\n"));

  assert.equal(assign(repo, ["--entry-file", entryFile("Anything.")]).status, 0);
  assert.deepEqual(versions(repo.dir), { marketplace: "0.1.10", plugin: "0.1.10" });
});

test("a branch that changes no file the plugin ships is left exactly as it is", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/src-only", () => write(repo.dir, join("src", "board.ts"), "export const x = 1;\n"));
  const head = git(repo.dir, "rev-parse", "HEAD");

  const ran = assign(repo, ["--entry-file", entryFile("Anything.")]);
  assert.equal(ran.status, 2, ran.out);
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), head, "a branch shipping no plugin file was committed to");
  assert.deepEqual(versions(repo.dir), { marketplace: "0.1.33", plugin: "0.1.33" });
});

test("a master version that is not three numbers is refused rather than guessed at", () => {
  const repo = repoAt("0.1.33");
  git(repo.dir, "checkout", "--quiet", "master");
  write(repo.dir, PLUGIN, `${JSON.stringify({ name: "devloop", version: "v0.1.33-rc" }, null, 2)}\n`);
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "--quiet", "-m", "Declare a version nobody can order");
  git(repo.dir, "update-ref", "refs/remotes/origin/master", git(repo.dir, "rev-parse", "HEAD"));
  branch(repo, "devloop/unreadable", () => write(repo.dir, SKILL, "Changed.\n"));
  const head = git(repo.dir, "rev-parse", "HEAD");

  const ran = assign(repo, ["--entry-file", entryFile("Anything.")]);
  assert.equal(ran.status, 5, ran.out);
  assert.match(ran.out, /plugin\.json/);
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), head, "a version was written over a number nobody could read");
});

test("a repository that ships no plugin manifest is skipped rather than refused", () => {
  const root = mkdtempSync(join(tmpdir(), "pitwall-assign-"));
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "nobody@example.invalid");
  git(dir, "config", "user.name", "Nobody");
  write(dir, "a.txt", "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/master", git(dir, "rev-parse", "HEAD"));

  const ran = assign({ dir, bin: join(root, "bin") });
  assert.equal(ran.status, 2, ran.out);
  assert.match(ran.out, /ships no plugins\/devloop\/\.claude-plugin\/plugin\.json/);
});

test("the changelog text comes from the pull request body, under its own heading", () => {
  const repo = repoAt("0.1.33", {
    body: [
      "Five plugin branches all declared the same number.",
      "",
      "## Plugin changelog",
      "",
      "The lander assigns the plugin version at merge time.",
      "A branch that reads master and bumps is always one merge behind.",
      "",
      "## Test plan",
      "",
      "npm test",
    ].join("\n"),
  });
  branch(repo, "devloop/body", () => write(repo.dir, SKILL, "Changed.\n"));

  assert.equal(assign(repo, ["--slug", "404sl/pitwall", "--pr", "126"]).status, 0);
  const log = read(repo.dir, LOG);
  assert.match(log, /## 0\.1\.34\n\nThe lander assigns the plugin version at merge time\./);
  assert.match(log, /A branch that reads master and bumps is always one merge behind\./);
  assert.doesNotMatch(log, /Test plan/);
  assert.doesNotMatch(log, /npm test/);
  assert.doesNotMatch(log, /Five plugin branches/);
});

test("a pull request body with no changelog section falls back to the title rather than writing an empty entry", () => {
  const repo = repoAt("0.1.33", { body: "No section here.", title: "Stop lanes choosing the plugin version" });
  branch(repo, "devloop/untitled", () => write(repo.dir, SKILL, "Changed.\n"));

  assert.equal(assign(repo, ["--slug", "404sl/pitwall", "--pr", "140"]).status, 0);
  assert.match(read(repo.dir, LOG), /## 0\.1\.34\n\nStop lanes choosing the plugin version\n/);
});

test("a changelog heading with nothing under it falls back to the title rather than writing a bare heading", () => {
  const repo = repoAt("0.1.33", {
    body: "Why this change.\n\n## Plugin changelog\n\n",
    title: "Stop lanes choosing the plugin version",
  });
  branch(repo, "devloop/blank-section", () => write(repo.dir, SKILL, "Changed.\n"));

  assert.equal(assign(repo, ["--slug", "404sl/pitwall", "--pr", "141"]).status, 0);
  assert.match(read(repo.dir, LOG), /## 0\.1\.34\n\nStop lanes choosing the plugin version\n/);
});

test("a version is refused rather than moved when no changelog text can be read at all", () => {
  const repo = repoAt("0.1.33", { unreadable: ["142"] });
  branch(repo, "devloop/unreadable", () => write(repo.dir, SKILL, "Changed.\n"));
  const head = git(repo.dir, "rev-parse", "HEAD");

  const ran = assign(repo, ["--slug", "404sl/pitwall", "--pr", "142"]);

  assert.equal(
    ran.status,
    5,
    "a transient failure reading the pull request moved the plugin version anyway, and wrote a " +
      `heading with nothing under it - which is exactly what the changelog exists to deliver:\n${ran.out}`,
  );
  assert.match(ran.out, /^refused: no changelog text could be read for pull request #142/m, ran.out);
  assert.deepEqual(versions(repo.dir), { marketplace: "0.1.33", plugin: "0.1.33" });
  assert.doesNotMatch(read(repo.dir, LOG), /## 0\.1\.34/);
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), head, "a refusal still committed something");
  assert.equal(git(repo.dir, "status", "--porcelain"), "", "a refusal left the branch dirty");
});

test("a train whose second pull request cannot be read is refused naming that pull request", () => {
  const repo = repoAt("0.1.33", {
    body: "Why this change.\n\n## Plugin changelog\n\nWhat the first change did.\n",
    unreadable: ["144"],
  });
  branch(repo, "devloop/train-half-read", () => write(repo.dir, SKILL, "Changed.\n"));

  const ran = assign(repo, ["--slug", "404sl/pitwall", "--pr", "143", "--pr", "144"]);

  assert.equal(
    ran.status,
    5,
    "one unreadable pull request on a train was skipped while the others carried the entry, so a " +
      `change landed with nothing in the changelog naming it:\n${ran.out}`,
  );
  assert.match(ran.out, /^refused: no changelog text could be read for pull request #144/m, ran.out);
  assert.deepEqual(versions(repo.dir), { marketplace: "0.1.33", plugin: "0.1.33" });
});

test("a branch that changes the plugin manifest beyond its version is refused, not silently reverted", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/described", () =>
    write(
      repo.dir,
      PLUGIN,
      `${JSON.stringify({ name: "devloop", version: "0.1.33", description: "What the plugin is for." }, null, 2)}\n`,
    ),
  );
  const head = git(repo.dir, "rev-parse", "HEAD");

  const ran = assign(repo, ["--entry-file", entryFile("Anything.")]);

  assert.equal(
    ran.status,
    5,
    `a whole-file restore from master deleted a branch's own edit to the manifest and merged anyway, and CI cannot catch it because it only asserts the two manifests agree: ${ran.out}`,
  );
  assert.match(ran.out, /plugin\.json/, ran.out);
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), head, "the refusal still committed");
  assert.equal(git(repo.dir, "status", "--porcelain"), "", "the refusal left the worktree rewritten");
  assert.match(read(repo.dir, PLUGIN), /What the plugin is for\./, "the branch's own description was reverted");
});

test("a branch that adds a second marketplace entry is refused rather than having it deleted", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/second-plugin", () =>
    write(
      repo.dir,
      MARKETPLACE,
      `${JSON.stringify(
        {
          name: "pitwall",
          plugins: [
            { name: "devloop", version: "0.1.33", source: "./plugins/devloop" },
            { name: "pitstop", version: "0.0.1", source: "./plugins/pitstop" },
          ],
        },
        null,
        2,
      )}\n`,
    ),
  );

  const ran = assign(repo, ["--entry-file", entryFile("Anything.")]);

  assert.equal(ran.status, 5, ran.out);
  assert.match(ran.out, /marketplace\.json/, ran.out);
  assert.match(read(repo.dir, MARKETPLACE), /pitstop/, "the second plugin entry was deleted");
});

test("a branch that only prepends a changelog block is assigned over it rather than refused", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/prepended", () => {
    write(repo.dir, SKILL, "Changed.\n");
    write(
      repo.dir,
      LOG,
      "# Changelog\n\n## 0.1.34\n\nWhat this branch guessed.\n\n## 0.1.33\n\nWhat the version before this one did.\n",
    );
  });

  const ran = assign(repo, ["--entry-file", entryFile("What it actually did.")]);

  assert.equal(ran.status, 0, ran.out);
  const log = read(repo.dir, LOG);
  assert.match(log, /^# Changelog\n\n## 0\.1\.34\n\nWhat it actually did\.\n\n## 0\.1\.33\n/);
  assert.doesNotMatch(log, /What this branch guessed/);
});

test("a branch that rewrites an older changelog entry is refused, because the lander restores that file whole", () => {
  const repo = repoAt("0.1.33");
  const history = "# Changelog\n\n## 0.1.33\n\nWhat the version before this one did.\n\n## 0.1.32\n\nAnd the one before that.\n";
  git(repo.dir, "checkout", "--quiet", "master");
  write(repo.dir, LOG, history);
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "--quiet", "-m", "Record what 0.1.32 did");
  git(repo.dir, "update-ref", "refs/remotes/origin/master", git(repo.dir, "rev-parse", "HEAD"));

  branch(repo, "devloop/rewrote-history", () =>
    write(repo.dir, LOG, history.replace("And the one before that.", "Rewritten by a lane that does not own this file.")),
  );
  const head = git(repo.dir, "rev-parse", "HEAD");

  const ran = assign(repo, ["--entry-file", entryFile("Anything.")]);

  assert.equal(ran.status, 5, ran.out);
  assert.match(ran.out, /CHANGELOG\.md/, ran.out);
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), head, "the refusal still committed");
  assert.match(read(repo.dir, LOG), /Rewritten by a lane/, "the branch's edit was reverted");
});

test("running the assignment twice on one branch adds nothing the second time and still reports assigned", () => {
  const repo = repoAt("0.1.33");
  branch(repo, "devloop/twice", () => write(repo.dir, SKILL, "Changed.\n"));

  assert.equal(assign(repo, ["--entry-file", entryFile("What it did.")]).status, 0);
  const head = git(repo.dir, "rev-parse", "HEAD");
  const tree = git(repo.dir, "rev-parse", "HEAD^{tree}");

  const again = assign(repo, ["--entry-file", entryFile("What it did.")]);

  assert.equal(
    again.status,
    0,
    "a second run on a branch already assigned was refused, and land-one.sh turns any refusal " +
      `into a blocked pull request that no later round can unblock: ${again.out}`,
  );
  assert.match(again.out, /^assigned: devloop plugin version 0\.1\.34/m, again.out);
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), head, "the second run added a commit");
  assert.equal(git(repo.dir, "rev-parse", "HEAD^{tree}"), tree, "the second run changed the tree");
  assert.equal(git(repo.dir, "status", "--porcelain"), "", "the second run left the worktree dirty");
});
