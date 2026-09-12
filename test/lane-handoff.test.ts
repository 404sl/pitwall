import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV, spawnGit } from "./support/git.js";

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
  mergeable?: string;
  mergeState?: string;
  message?: string;
  listFails?: boolean;
  rollupFails?: boolean;
  rollupGarbled?: boolean;
  omitPath?: boolean;
  editFails?: boolean;
  labelMissing?: boolean;
  labelCreateFails?: boolean;
  labelListFails?: boolean;
  labelSimilar?: boolean;
  labelGarbled?: boolean;
  noSlug?: boolean;
  commitsFails?: boolean;
}

interface Primary {
  rollupHead?: string;
  refSha?: string;
  refFails?: boolean;
  message?: string;
}

function git(dir: string, ...args: string[]): string {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, ran.stderr);
  return (ran.stdout ?? "").trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function commitsJson(message: string, oid: string): string {
  const [headline, ...rest] = message.split("\n");
  return JSON.stringify({
    commits: [
      {
        messageHeadline: headline,
        messageBody: rest.join("\n").replace(/^\n/, ""),
        authors: [{ name: "Nobody", email: "nobody@example.invalid", login: "nobody" }],
        oid,
      },
    ],
  });
}

function harness(
  seededNotes: string,
  second?: Second,
  detached?: boolean,
  primary?: Primary,
): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-handoff-"));
  const repo = detached ? join(mkdtempSync(join(tmpdir(), "pitwall-lane-")), "repo") : join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(root, ".beads"));
  mkdirSync(repo);
  mkdirSync(bin);

  const config = join(root, ".pitwall.json");
  const repos: Record<string, Record<string, string>> = {
    site: { path: "repo", slug: "acme/thing" },
  };
  if (second) {
    if (second.omitPath) repos["other"] = { slug: "acme/other" };
    else if (second.noSlug) repos["docs"] = { path: "other" };
    else repos["docs"] = { path: "other", slug: "acme/other" };
  }
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
  git(repo, "commit", "--quiet", "-m", primary?.message ?? "Fix the thing");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", `refs/remotes/origin/${BRANCH}`, head);
  git(repo, "checkout", "--quiet", base);
  const thingCommits = join(root, "commits-thing.json");
  writeFileSync(thingCommits, `${commitsJson(primary?.message ?? "Fix the thing", head)}\n`);

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
    git(other, "remote", "add", "origin", second.noSlug ? "https://github.com/acme/other.git" : origin);
    writeFileSync(join(other, "b.txt"), "one\n");
    git(other, "add", "b.txt");
    git(other, "commit", "--quiet", "-m", "base");
    const otherBase = git(other, "rev-parse", "HEAD");
    git(other, "update-ref", "refs/remotes/origin/master", otherBase);
    writeFileSync(join(other, "b.txt"), "two\n");
    git(other, "add", "b.txt");
    git(other, "commit", "--quiet", "-m", second.message ?? "Regenerate the artwork from the same source");
    otherHead = git(other, "rev-parse", "HEAD");
    git(other, "update-ref", `refs/remotes/origin/${BRANCH}`, otherHead);
    git(other, "checkout", "--quiet", otherBase);
    writeFileSync(
      join(root, "commits-other.json"),
      `${commitsJson(second.message ?? "Regenerate the artwork from the same source", otherHead)}\n`,
    );
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
            `  "pr list --repo acme/other"*)${
              second.listFails
                ? ` echo "gh: could not read acme/other" >&2; exit 1 ;;`
                : ` printf '%s\\n' '${second.list}' ;;`
            }`,
            `  "api repos/acme/other/git/ref/heads/${BRANCH}"*) printf '{"object":{"sha":"${otherHead}"}}\\n' ;;`,
            `  *"--repo acme/other"*statusCheckRollup*)${
              second.rollupFails
                ? ` echo "gh: API rate limit exceeded for acme/other" >&2; exit 1 ;;`
                : second.rollupGarbled
                  ? ` printf 'error connecting to api.github.com\\n' ;;`
                  : ` printf '{"statusCheckRollup":%s,"headRefOid":"%s"${
                      second.mergeable ? `,"mergeable":"${second.mergeable}"` : ""
                    }${second.mergeState ? `,"mergeStateStatus":"${second.mergeState}"` : ""}}\\n' '${second.rollup}' '${otherHead}' ;;`
            }`,
            `  *"--repo acme/other --json title,body"*) printf '%s\\n' '${second.body}' ;;`,
            `  *"--repo acme/other --json commits"*)${
              second.commitsFails
                ? ` echo "gh: API rate limit exceeded for acme/other" >&2; exit 1 ;;`
                : ` cat "${join(root, "commits-other.json")}" ;;`
            }`,
            `  "label list --repo acme/other"*)${
              second.labelListFails
                ? ` echo "gh: HTTP 403 on acme/other labels" >&2; exit 1 ;;`
                : second.labelSimilar
                  ? ` printf '[{"name":"lane-verified-2025"}]\\n' ;;`
                  : second.labelGarbled
                    ? ` printf 'not json at all\\n' ;;`
                    : second.labelMissing
                      ? ` : ;;`
                      : ` printf '[{"name":"lane-verified"}]\\n' ;;`
            }`,
            `  "label create"*"--repo acme/other"*)${
              second.labelCreateFails
                ? ` echo "gh: HTTP 403 creating a label on acme/other" >&2; exit 1 ;;`
                : ` : ;;`
            }`,
            ...(second.editFails
              ? [
                  `  "pr edit 7 --repo acme/other"*) echo "gh: could not add label: HTTP 403" >&2; exit 1 ;;`,
                  `  *"--repo acme/other"*"--json labels"*) printf '{"labels":[]}\\n' ;;`,
                ]
              : []),
          ]
        : []),
      `  "pr list --repo acme/thing"*) printf '[{"number":14}]\\n' ;;`,
      `  "api repos/acme/thing/git/ref/heads/${BRANCH}"*)${
        primary?.refFails
          ? ` echo '{"message":"Not Found","status":"404"}' >&2; exit 1 ;;`
          : ` printf '{"object":{"sha":"${primary?.refSha ?? head}"}}\\n' ;;`
      }`,
      `  *statusCheckRollup*) printf '{"statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"headRefOid":"${primary?.rollupHead ?? head}"}\\n' ;;`,
      `  *"--json title,body"*) printf '{"title":"Fix the thing","body":"It was broken. Now it is not."}\\n' ;;`,
      `  *"--json commits"*) cat "${thingCommits}" ;;`,
      `  *"--json labels"*) printf '{"labels":[{"name":"lane-verified"}]}\\n' ;;`,
      `  "label list"*) printf '[{"name":"lane-verified"}]\\n' ;;`,
      `  "label create"*) : ;;`,
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

function handoff(
  box: Harness,
  args: string[],
  record: boolean,
  env: Record<string, string> = {},
): Ran {
  const ran = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      BD_NOTES: box.notesFile,
      BD_RECORD: record ? "1" : "0",
      ...env,
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

test("a conflicted pull request is reported as conflicted rather than waited on as pending", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: "[]",
    body: CLEAN,
    mergeable: "CONFLICTING",
    mergeState: "DIRTY",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 3, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /conflicted: acme\/other#7 conflicts with master/);
  assert.doesNotMatch(ran.stdout, /not-green/);
  assert.equal(ran.labelled, false, "a conflicted pull request was labelled");
});

test("an uncomputed mergeability is not read as a conflict", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: "[]",
    body: CLEAN,
    mergeable: "UNKNOWN",
    mergeState: "UNKNOWN",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 4, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /not-green: rollup is empty on acme\/other#7/);
  assert.doesNotMatch(ran.stdout, /conflicted/);
  assert.equal(ran.labelled, false, "an unready pull request was labelled");
});

test("a failing check is reported as red, not as a conflict", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: '[{"name":"ci","conclusion":"FAILURE"}]',
    body: CLEAN,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 4, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /not-green: BAD:ci on acme\/other#7/);
  assert.doesNotMatch(ran.stdout, /conflicted/);
  assert.equal(ran.labelled, false, "a red pull request was labelled");
});

test("a rollup gh could not fetch is reported as unreadable, not as not-green", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, rollupFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 9, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /unreadable: could not read the status rollup for acme\/other#7/);
  assert.match(
    ran.stdout,
    /attempted: gh pr view 7 --repo acme\/other --json statusCheckRollup,headRefOid,mergeable,mergeStateStatus/,
  );
  assert.match(ran.stdout, /gh exited 1 and said: gh: API rate limit exceeded for acme\/other/);
  assert.doesNotMatch(ran.stdout, /not-green/);
  assert.doesNotMatch(ran.stdout, /conflicted/);
  assert.equal(ran.labelled, false, "a pull request whose rollup was never read was labelled");
});

test("a rollup that does not parse is reported as unreadable, not as not-green", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, rollupGarbled: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 9, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /unreadable: the status rollup for acme\/other#7 did not parse/);
  assert.match(
    ran.stdout,
    /attempted: gh pr view 7 --repo acme\/other --json statusCheckRollup,headRefOid,mergeable,mergeStateStatus/,
  );
  assert.match(ran.stdout, /beginning: error connecting to api.github.com/);
  assert.doesNotMatch(ran.stdout, /not-green/);
  assert.equal(ran.labelled, false, "a pull request whose rollup did not parse was labelled");
});

test("a green pull request that conflicts with master is still handed off for the lander to rebase", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    mergeable: "CONFLICTING",
    mergeState: "DIRTY",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
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

test("a commit message naming the plugin manifest and skill directories is compliant", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    message: "Bump the manifests\n\n.claude-plugin/marketplace.json, plugins/devloop/.claude-plugin/plugin.json and plugins/devloop/skills/devloop/CHANGELOG.md all moved together.",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.doesNotMatch(ran.stdout, /non-compliant/);
  assert.match(ran.calls, /pr edit 7 --repo acme\/other/);
});

test("a refusal tells a lane the exit is terminal and that its judgement only picks the rewording", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: '{"title":"Regenerate the artwork","body":"Green and labelled lane-verified, awaiting the lander."}',
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.match(ran.stdout, /THIS REFUSAL IS TERMINAL/);
  assert.match(ran.stdout, /HOW TO REWORD a hit, never whether to proceed past it/);
  assert.match(ran.stdout, /the only way to a label is a re-run of this script that exits 0/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite naming its own pipeline state");
});

test("the handoff label typeset as a code span is refused, and the refusal names the rewrite", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: '{"title":"Refuse a guessed pull request number","body":"A guess that names a real pull request in another repository is how the `lane-verified` label reaches the wrong one."}',
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.equal(
    ran.labelled,
    false,
    "typesetting the token as a code span carried it past the leakage check - a spelling the gate " +
      "lets through is a spelling a forged status report can use",
  );
  assert.match(ran.stdout, /NO SUCH\n?EXEMPTION AND NO COMPLIANT SPELLING/);
  assert.match(ran.stdout, /naming the label in words/);
});

test("a refusal on the handoff label gives documentation the same rewrite as a self-report", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: '{"title":"Document the lander queue","body":"The lander only reads pull requests labelled `lane-verified`."}',
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.equal(ran.labelled, false);
  assert.match(
    ran.stdout,
    /whether the sentence reports THIS pull request's own state or is documentation about the\n?handoff mechanics - both are reworded the same way/,
    "a lane quoting the repository's own documentation is refused with advice written only for a " +
      "self-report, which is the framework gap that invited the by-hand label on 2026-09-12",
  );
});

test("a body claiming a machine author leaves NOTHING labelled", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: '{"title":"Regenerate the artwork","body":"Generated with Claude Code."}',
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite an authorship claim");
});

test("a commit carrying an authorship trailer leaves NOTHING labelled", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    message: "Regenerate the artwork\n\nCo-Authored-By: Nobody <nobody@example.invalid>",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite an authorship trailer");
});

test("a commit message naming a scratch checkout path leaves NOTHING labelled", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    message: "Regenerate the artwork\n\nCaptured under /tmp/lanes/acme-14/repo while checking.",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite a scratch path");
});

test("a bare pipeline noun outside a path is still not compliant", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    message: "Regenerate the artwork\n\nThe devloop takes ready work and lands it.",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite a bare pipeline noun");
});

test("a repository whose open pull requests cannot be read is refused, not read as having none", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN, listFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
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

test("a sibling that cannot be given the label leaves NOTHING labelled", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    labelMissing: true,
    labelCreateFails: true,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /acme\/other has no lane-verified label and one could not be created/);
  assert.match(ran.stderr, /gh said: gh: HTTP 403 creating a label on acme\/other/);
  assert.equal(ran.labelled, false, "a pull request was labelled before the set could all carry it");
});

test("a sibling whose labels cannot be read leaves NOTHING labelled", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    labelListFails: true,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /could not read the labels of acme\/other/);
  assert.equal(ran.labelled, false, "a pull request was labelled on an unreadable label list");
});

test("a label missing from a sibling is created before any pull request is labelled", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, labelMissing: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /created the lane-verified label in acme\/other/);
  assert.ok(
    ran.calls.indexOf("label create") < ran.calls.indexOf("pr edit"),
    `the label was created after the first pull request was labelled:\n${ran.calls}`,
  );
});

test("a sibling whose only near-match is a different label gets the label created", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, labelSimilar: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /created the lane-verified label in acme\/other/);
  assert.ok(
    ran.calls.indexOf("label create") < ran.calls.indexOf("pr edit"),
    `the label was created after the first pull request was labelled:\n${ran.calls}`,
  );
});

test("a sibling whose label list is unreadable shape leaves NOTHING labelled", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, labelGarbled: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /acme\/other answered its label list in a shape this cannot read/);
  assert.match(ran.stderr, /it said: not json at all/);
  assert.equal(ran.labelled, false, "a pull request was labelled on an unreadable label list");
  assert.doesNotMatch(ran.calls, /label create/);
});

test("a label that will not stick on a sibling names the pull requests that DO carry it", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, editFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 8, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /half-labelled: the label did not stick on acme\/other#7/);
  assert.match(ran.stdout, /gh said: gh: could not add label: HTTP 403/);
  assert.match(ran.stdout, /CARRYING lane-verified now: acme\/thing#14/);
  assert.match(ran.stdout, /NOT carrying it: acme\/other#7/);
  assert.match(ran.stdout, /RE-RUN this command/);
  assert.doesNotMatch(ran.stdout, /^handed off: /m);
});

test("a handoff that cannot find the workspace config refuses instead of labelling the one it was told about", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN }, true);
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    true,
    { PITWALL_CONFIG: "", DEVLOOP_CONFIG: "" },
  );

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /the workspace config could not be read/);
  assert.match(ran.stderr, /no \.pitwall\.json or \.autofix\.json found/);
  assert.equal(ran.labelled, false, "the named pull request was labelled with the set unknown");
});

test("a workspace config naming no repositories refuses instead of labelling the one it was told about", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  writeFileSync(
    box.config,
    JSON.stringify({ root: box.root, lockPrefix: `pwhandoff${process.pid}`, repos: {} }),
  );
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /names no repositories/);
  assert.equal(ran.labelled, false, "the named pull request was labelled with the set unknown");
});

test("a configured repository with no path of its own is read under its name", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, omitPath: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.match(ran.calls, /pr edit 7 --repo acme\/other/);
});

test("a configured repository with no slug has one read from its own origin", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, noSlug: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.match(ran.calls, /pr edit 7 --repo acme\/other/);
});

function elsewhere(box: Harness): string {
  const dir = join(box.root, "elsewhere");
  mkdirSync(dir);
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "nobody@example.invalid");
  git(dir, "config", "user.name", "Nobody");
  writeFileSync(join(dir, "c.txt"), "one\n");
  git(dir, "add", "c.txt");
  git(dir, "commit", "--quiet", "-m", "unrelated");
  return dir;
}

function fromElsewhere(box: Harness, dir: string): string[] {
  return [
    "--repo-path",
    dir,
    "--slug",
    "acme/thing",
    "--pr",
    "14",
    "--branch",
    BRANCH,
    "--issue",
    "acme-1",
    "--note-file",
    box.notePath,
  ];
}

test("a --repo-path whose checkout does not carry the branch still hands off a green, compliant pull request", () => {
  const box = harness("");
  const ran = handoff(box, fromElsewhere(box, elsewhere(box)), true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.match(ran.calls, /pr view 14 --repo acme\/thing --json commits/);
  assert.doesNotMatch(ran.stderr, /could not read/);
});

test("a commit claiming a machine author is refused even when the checkout does not carry the branch", () => {
  const box = harness("", undefined, undefined, {
    message: "Fix the thing\n\nWritten by an AI assistant.",
  });
  const ran = handoff(box, fromElsewhere(box, elsewhere(box)), true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/thing#14/);
  assert.match(ran.stdout, /Written by an AI assistant/);
  assert.equal(ran.labelled, false, "a pull request was labelled with an authorship claim in a commit the checkout never held");
});

test("commits GitHub will not report are refused, not graded on the body alone", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, commitsFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /could not read the commits of acme\/other#7 from GitHub/);
  assert.doesNotMatch(ran.stdout, /not-green/);
  assert.equal(ran.labelled, false, "a pull request was labelled with its commit messages never read");
});

test("the head sha is the one GitHub reports, not the one the checkout is at", () => {
  const remote = "f".repeat(40);
  const box = harness("", undefined, undefined, { refSha: remote, rollupHead: remote });
  const local = git(box.repo, "rev-parse", `refs/remotes/origin/${BRANCH}`);
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.calls, new RegExp(`api repos/acme/thing/git/ref/heads/${BRANCH}`));
  assert.match(ran.stdout, new RegExp(`handed off: acme/thing#14 at ${remote}`));
  assert.doesNotMatch(ran.stdout, new RegExp(local));
});

test("a rollup describing an older head is still refused", () => {
  const stale = "0".repeat(40);
  const box = harness("", undefined, undefined, { rollupHead: stale });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 4, ran.stdout + ran.stderr);
  assert.match(ran.stdout, new RegExp(`rollup describes ${stale} but the head of acme/thing#14 is `));
  assert.equal(ran.labelled, false, "a pull request was labelled on a rollup for an older head");
});

test("a head sha GitHub will not report is refused instead of reported as not-green", () => {
  const box = harness("", undefined, undefined, { refFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /could not read what sha lane\/x is at in acme\/thing/);
  assert.doesNotMatch(ran.stdout, /not-green/);
  assert.equal(ran.labelled, false, "a pull request was labelled on an unreadable head sha");
});
