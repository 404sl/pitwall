import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "lane-handoff.sh",
);

const BRANCH = "lane/x";
const LINK = "Handed off https://example.invalid/acme/thing/pull/14 - green on the second run.";
const NOTE = [LINK, "Kept both sides of the merge."].join("\n");

interface Harness {
  root: string;
  repo: string;
  bin: string;
  config: string;
  notePath: string;
  notesFile: string;
  ghLog: string;
}

interface Second {
  list: string;
  rollup: string;
  body: string;
  listFails?: boolean;
}

function git(dir: string, ...args: string[]): string {
  const ran = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return (ran.stdout ?? "").trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function harness(seededNotes: string, second?: Second): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-handoff-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(root, ".beads"));
  mkdirSync(repo);
  mkdirSync(bin);

  const config = join(root, ".pitwall.json");
  const repos = second
    ? {
        site: { path: "repo", slug: "acme/thing" },
        docs: { path: "other", slug: "acme/other" },
      }
    : {};
  writeFileSync(
    config,
    JSON.stringify({ root, lockPrefix: `pwhandoff${process.pid}`, repos }),
  );

  git(repo, "init", "--quiet");
  git(repo, "config", "user.email", "nobody@example.invalid");
  git(repo, "config", "user.name", "Nobody");
  git(repo, "remote", "add", "origin", "https://github.com/acme/thing.git");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "--quiet", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/master", base);
  writeFileSync(join(repo, "a.txt"), "two\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "--quiet", "-m", "Fix the thing");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", `refs/remotes/origin/${BRANCH}`, head);
  git(repo, "checkout", "--quiet", base);

  let otherHead = "";
  if (second) {
    const other = join(root, "other");
    const origin = join(root, "other-origin.git");
    mkdirSync(other);
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--bare");
    git(other, "init", "--quiet");
    git(other, "config", "user.email", "nobody@example.invalid");
    git(other, "config", "user.name", "Nobody");
    git(other, "remote", "add", "origin", origin);
    writeFileSync(join(other, "b.txt"), "one\n");
    git(other, "add", "b.txt");
    git(other, "commit", "--quiet", "-m", "base");
    const otherBase = git(other, "rev-parse", "HEAD");
    git(other, "update-ref", "refs/remotes/origin/master", otherBase);
    writeFileSync(join(other, "b.txt"), "two\n");
    git(other, "add", "b.txt");
    git(other, "commit", "--quiet", "-m", "Regenerate the artwork from the same source");
    otherHead = git(other, "rev-parse", "HEAD");
    git(other, "update-ref", `refs/remotes/origin/${BRANCH}`, otherHead);
    git(other, "checkout", "--quiet", otherBase);
  }

  const ghLog = join(root, "gh.log");
  executable(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${ghLog}"`,
      'case "$*" in',
      ...(second
        ? [
            `  "pr list --repo acme/thing"*) printf '[{"number":14}]\\n' ;;`,
            second.listFails
              ? `  "pr list --repo acme/other"*) echo "gh: could not read acme/other" >&2; exit 1 ;;`
              : `  "pr list --repo acme/other"*) printf '%s\\n' '${second.list}' ;;`,
            `  *"--repo acme/other"*statusCheckRollup*) printf '{"statusCheckRollup":%s,"headRefOid":"%s"}\\n' '${second.rollup}' '${otherHead}' ;;`,
            `  *"--repo acme/other --json title,body"*) printf '%s\\n' '${second.body}' ;;`,
          ]
        : []),
      `  *statusCheckRollup*) printf '{"statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"headRefOid":"${head}"}\\n' ;;`,
      `  *"--json title,body"*) printf '{"title":"Fix the thing","body":"It was broken. Now it is not."}\\n' ;;`,
      `  *"--json labels"*) printf '{"labels":[{"name":"lane-verified"}]}\\n' ;;`,
      "  *\"pr edit\"*) : ;;",
      '  *) echo "gh stub: unhandled $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );

  const notesFile = join(root, "notes.txt");
  writeFileSync(notesFile, seededNotes);
  executable(
    join(bin, "bd"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  update)",
      '    [ "${BD_RECORD:-0}" = "1" ] && printf \'%s\\n\' "$4" >> "$BD_NOTES"',
      '    echo "Updated issue: $2"',
      "    ;;",
      "  show)",
      "    python3 -c 'import io,json,sys; print(json.dumps({\"id\": sys.argv[1], \"status\": \"open\", \"notes\": io.open(sys.argv[2]).read()}))' \"$2\" \"$BD_NOTES\"",
      "    ;;",
      '  *) echo "bd stub: unhandled $*" >&2; exit 2 ;;',
      "esac",
      "",
    ].join("\n"),
  );

  const notePath = join(root, "note.txt");
  writeFileSync(notePath, `${NOTE}\n`);

  return { root, repo, bin, config, notePath, notesFile, ghLog };
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
  labelled: boolean;
  calls: string;
}

function handoff(box: Harness, args: string[], record: boolean): Ran {
  const ran = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      BD_NOTES: box.notesFile,
      BD_RECORD: record ? "1" : "0",
    },
  });
  let calls = "";
  try {
    calls = readFileSync(box.ghLog, "utf8");
  } catch {
    calls = "";
  }
  return {
    status: ran.status ?? -1,
    stdout: ran.stdout ?? "",
    stderr: ran.stderr ?? "",
    labelled: calls.includes("pr edit"),
    calls,
  };
}

function required(box: Harness): string[] {
  return ["--repo-path", box.repo, "--slug", "acme/thing", "--pr", "14", "--branch", BRANCH];
}

test("a note file with no issue to write it to is refused before anything is labelled", () => {
  const box = harness("");
  const ran = handoff(box, [...required(box), "--note-file", box.notePath], true);

  assert.equal(ran.status, 6, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /--issue/);
  assert.equal(ran.labelled, false, "the pull request was labelled despite the refusal");
});

test("a note file that is not there is refused before anything is labelled", () => {
  const box = harness("");
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", join(box.root, "gone.txt")],
    true,
  );

  assert.equal(ran.status, 6, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /does not exist/);
  assert.equal(ran.labelled, false, "the pull request was labelled despite the refusal");
});

test("a note that lands is reported as landed", () => {
  const box = harness("");
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.match(readFileSync(box.notesFile, "utf8"), /Kept both sides of the merge/);
});

test("a note the tracker never took exits non-zero instead of reporting a handoff", () => {
  const box = harness("");
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    false,
  );

  assert.equal(ran.status, 5, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /note-unconfirmed/);
  assert.doesNotMatch(ran.stdout, /^handed off: /m);
});

test("an earlier note carrying the same link does not pass a lost note off as present", () => {
  const box = harness(`${LINK}\n`);
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    false,
  );

  assert.equal(ran.status, 5, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /note-unconfirmed/);
});

const READY = '[{"name":"ci","conclusion":"SUCCESS"}]';
const CLEAN = '{"title":"Regenerate the artwork","body":"The generator was the orphan. Now it is not."}';

test("every repository with a pull request on the branch is labelled, not only the one named", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.match(ran.calls, /pr edit 14 --repo acme\/thing/);
  assert.match(ran.calls, /pr edit 7 --repo acme\/other/);
});

test("a second repository's pull request that is not green leaves NOTHING labelled", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: "[]", body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 4, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /acme\/other#7/);
  assert.doesNotMatch(ran.stdout, /^handed off: /m);
  assert.equal(ran.labelled, false, "a pull request was labelled while a second one was not ready");
});

test("a second repository's pull request whose body names the pipeline leaves NOTHING labelled", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: '{"title":"Regenerate the artwork","body":"Captured under /tmp/shots while checking."}',
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite a non-compliant sibling");
});

test("a repository whose open pull requests cannot be read is refused, not read as having none", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN, listFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 6, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /could not list the open pull requests of acme\/other/);
  assert.equal(ran.labelled, false, "the pull request was labelled on an unreadable survey");
});

test("a repository the config names with no pull request on the branch is not labelled", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.doesNotMatch(ran.stdout, /also labelled/);
  assert.doesNotMatch(ran.calls, /pr edit \d+ --repo acme\/other/);
});
