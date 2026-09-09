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

function git(dir: string, ...args: string[]): string {
  const ran = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return (ran.stdout ?? "").trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function harness(seededNotes: string): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-handoff-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(root, ".beads"));
  mkdirSync(repo);
  mkdirSync(bin);

  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ lockPrefix: `pwhandoff${process.pid}`, repos: {} }));

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

  const ghLog = join(root, "gh.log");
  executable(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${ghLog}"`,
      'case "$*" in',
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
