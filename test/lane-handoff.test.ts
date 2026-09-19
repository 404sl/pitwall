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
const PLUGIN_GATE = join("plugins", "devloop", "skills", "devloop", "lane-handoff.sh");
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
  statuses?: string;
  mergeable?: boolean | null;
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
  pluginSource?: boolean;
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

function plantPluginSource(repo: string): void {
  mkdirSync(join(repo, "plugins", "devloop", "skills", "devloop"), { recursive: true });
  writeFileSync(join(repo, PLUGIN_GATE), "#!/bin/bash\n");
  git(repo, "add", PLUGIN_GATE);
}

function commitsJson(message: string, oid: string): string {
  const who = { name: "Nobody", email: "nobody@example.invalid", date: "2026-09-19T00:00:00Z" };
  return JSON.stringify([[{ sha: oid, commit: { message, author: who, committer: who } }]]);
}

function pullJson(titleAndBody: string, sha: string, mergeable?: boolean | null, mergeState?: string): string {
  return JSON.stringify({
    ...(JSON.parse(titleAndBody) as Record<string, string>),
    head: { sha },
    mergeable: mergeable ?? null,
    mergeable_state: mergeState ?? "unknown",
  });
}

const RATE_LIMITED = "gh: API rate limit exceeded for user ID 7195135 (HTTP 403)";

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
    if (second.pluginSource) plantPluginSource(other);
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
  const otherPull = second
    ? pullJson(second.body, otherHead, second.mergeable, second.mergeState)
    : "";
  const thingPull = pullJson(
    '{"title":"Fix the thing","body":"It was broken. Now it is not."}',
    primary?.rollupHead ?? head,
  );
  executable(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${ghLog}"`,
      'if [ -n "${GH_STUB_THROTTLE:-}" ]; then',
      '  case "$*" in',
      '    "$GH_STUB_THROTTLE"*)',
      `      n=$(cat "${ghLog}.throttle" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${ghLog}.throttle"`,
      `      if [ "$n" -le "\${GH_STUB_THROTTLE_TIMES:-1}" ]; then echo "${RATE_LIMITED}" >&2; exit 1; fi ;;`,
      "  esac",
      "fi",
      'case "$*" in',
      ...(second
        ? [
            `  "api -X GET repos/acme/other/pulls -f head="*)${
              second.listFails
                ? ` echo "gh: could not read acme/other" >&2; exit 1 ;;`
                : ` printf '%s\\n' '${second.list}' ;;`
            }`,
            `  "api repos/acme/other/git/ref/heads/${BRANCH}"*) printf '{"object":{"sha":"${otherHead}"}}\\n' ;;`,
            `  "api repos/acme/other/pulls/7") printf '%s\\n' '${otherPull}' ;;`,
            `  "api -X GET repos/acme/other/pulls/7/commits"*)${
              second.commitsFails
                ? ` echo "gh: API rate limit exceeded for acme/other" >&2; exit 1 ;;`
                : ` cat "${join(root, "commits-other.json")}" ;;`
            }`,
            `  "api -X GET repos/acme/other/commits/${otherHead}/check-runs"*)${
              second.rollupFails
                ? ` echo "gh: API rate limit exceeded for acme/other" >&2; exit 1 ;;`
                : second.rollupGarbled
                  ? ` printf 'error connecting to api.github.com\\n' ;;`
                  : ` printf '[{"total_count":1,"check_runs":%s}]\\n' '${second.rollup}' ;;`
            }`,
            `  "api -X GET repos/acme/other/commits/${otherHead}/status"*) printf '[{"state":"pending","statuses":%s}]\\n' '${second.statuses ?? "[]"}' ;;`,
            `  "api -X GET repos/acme/other/labels"*)${
              second.labelListFails
                ? ` echo "gh: HTTP 403 on acme/other labels" >&2; exit 1 ;;`
                : second.labelSimilar
                  ? ` printf '[[{"name":"lane-verified-2025"}]]\\n' ;;`
                  : second.labelGarbled
                    ? ` printf 'not json at all\\n' ;;`
                    : second.labelMissing
                      ? ` : ;;`
                      : ` printf '[[{"name":"lane-verified"}]]\\n' ;;`
            }`,
            `  "label create"*"--repo acme/other"*)${
              second.labelCreateFails
                ? ` echo "gh: HTTP 403 creating a label on acme/other" >&2; exit 1 ;;`
                : ` : ;;`
            }`,
            ...(second.editFails
              ? [
                  `  "api -X POST repos/acme/other/issues/7/labels"*) echo "gh: could not add label: HTTP 403" >&2; exit 1 ;;`,
                  `  "api -X GET repos/acme/other/issues/7/labels"*) printf '[[]]\\n' ;;`,
                ]
              : []),
          ]
        : []),
      `  "api -X GET repos/acme/thing/pulls -f head="*) printf '[{"number":14}]\\n' ;;`,
      `  "api repos/acme/thing/git/ref/heads/${BRANCH}"*)${
        primary?.refFails
          ? ` echo '{"message":"Not Found","status":"404"}' >&2; exit 1 ;;`
          : ` printf '{"object":{"sha":"${primary?.refSha ?? head}"}}\\n' ;;`
      }`,
      `  "api repos/acme/thing/pulls/14") printf '%s\\n' '${thingPull}' ;;`,
      `  "api -X GET repos/acme/thing/pulls/14/commits"*) cat "${thingCommits}" ;;`,
      `  "api -X GET repos/acme/thing/commits/"*"/check-runs"*) printf '[{"total_count":1,"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}]\\n' ;;`,
      `  "api -X GET repos/acme/thing/commits/"*"/status"*) printf '[{"state":"success","statuses":[]}]\\n' ;;`,
      `  "api -X GET repos/acme/thing/labels"*) printf '[[{"name":"lane-verified"}]]\\n' ;;`,
      `  "api -X POST "*"/labels"*) printf '[{"name":"lane-verified"}]\\n' ;;`,
      `  *"/issues/"*"/labels"*) printf '[[{"name":"lane-verified"}]]\\n' ;;`,
      `  "label create"*) : ;;`,
      `  "pr "*|"label list"*) echo "GraphQL: API rate limit already exceeded for user ID 7195135" >&2; exit 1 ;;`,
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
      '    if [ "${BD_RECORD:-0}" = "1" ]; then',
      '      if [ "${BD_TRANSFORM:-0}" = "1" ]; then',
      "        printf '%s\\n' \"$4\" | sed 's/<[^>]*>//g' >> \"$BD_NOTES\"",
      "      else",
      '        printf \'%s\\n\' "$4" >> "$BD_NOTES"',
      "      fi",
      "    fi",
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
  signal: string | null;
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
  timeout?: number,
): Ran {
  const ran = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      BD_NOTES: box.notesFile,
      BD_RECORD: record ? "1" : "0",
      LANE_HANDOFF_REST_BACKOFF: "0",
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
    signal: ran.signal,
    stdout: ran.stdout ?? "",
    stderr: ran.stderr ?? "",
    labelled: /^api -X POST repos\/[^ ]+\/issues\/\d+\/labels /m.test(calls),
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
  assert.match(ran.stdout, /bd-note\.sh acme-1 --note-file/);
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

test("a note the tracker altered on the way in is landed, not one to append a second time", () => {
  const box = harness("");
  writeFileSync(box.notePath, `${LINK}\nRebased onto <sha> and kept both sides.\n`);
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    true,
    { BD_TRANSFORM: "1" },
  );

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off WITH A WARNING: acme-1 holds the note in transformed form/);
  assert.match(ran.stdout, /diverges at character \d+ of \d+/);
  assert.match(ran.stdout, /^handed off: acme\/thing#14/m);
  assert.doesNotMatch(ran.stdout, /note-unconfirmed/);
  assert.doesNotMatch(ran.stdout, /bd-note\.sh acme-1 --note-file/);

  const stored = readFileSync(box.notesFile, "utf8");
  assert.equal(stored.split("Rebased onto").length - 1, 1, stored);
  assert.doesNotMatch(stored, /<sha>/);
});

test("a notes field that cannot be read at all is unreadable, not a note to append again", () => {
  const box = harness("");
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    false,
    { BD_NOTES: join(box.root, "gone.txt") },
  );

  assert.equal(ran.status, 5, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /could not be read back at all/);
  assert.doesNotMatch(ran.stdout, /bd-note\.sh acme-1 --note-file/);
});

const READY = '[{"name":"ci","status":"completed","conclusion":"success"}]';
const CLEAN = '{"title":"Regenerate the artwork","body":"The generator was the orphan. Now it is not."}';

test("every repository with a pull request on the branch is labelled, not only the one named", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.match(ran.calls, /^api -X POST repos\/acme\/thing\/issues\/14\/labels /m);
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels /m);
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
    mergeable: false,
    mergeState: "dirty",
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
    mergeable: null,
    mergeState: "unknown",
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
    rollup: '[{"name":"ci","status":"completed","conclusion":"failure"}]',
    body: CLEAN,
    mergeable: true,
    mergeState: "clean",
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
    /attempted: gh api repos\/acme\/other\/commits\/[0-9a-f]{40}\/check-runs/,
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
    /attempted: gh api repos\/acme\/other\/commits\/[0-9a-f]{40}\/check-runs/,
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
    mergeable: false,
    mergeState: "dirty",
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
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels /m);
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

const PLUGIN_NOUN = "Resolve the root the way queue.sh does\n\nThe guard reads DEVLOOP_ROOT first, then walks up, so the devloop finds its config from a worktree.";

test("a commit message naming the plugin is compliant in the repository that ships it", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    message: PLUGIN_NOUN,
    pluginSource: true,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.doesNotMatch(ran.stdout, /non-compliant/);
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels /m);
});

test("a pull request body naming the plugin is compliant in the repository that ships it", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: '{"title":"Resolve the root","body":"The devloop reads DEVLOOP_ROOT before walking up."}',
    pluginSource: true,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.doesNotMatch(ran.stdout, /non-compliant/);
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels /m);
});

test("the same message naming the plugin is still refused in a repository that does not ship it", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    body: CLEAN,
    message: PLUGIN_NOUN,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant: acme\/other#7/);
  assert.equal(ran.labelled, false, "a pull request was labelled despite a bare pipeline noun");
});

for (const [what, message] of [
  ["the handoff label token", "Read the token back\n\nThe gate greps for lane-verified itself."],
  ["a scratch path", "Regenerate the artwork\n\nCaptured under /tmp/lanes/acme-14/repo while checking."],
  ["a private scratch path", "Regenerate the artwork\n\nCaptured under /private/tmp/lanes/acme-14/repo while checking."],
]) {
  test(`${what} in a commit message is still refused in the repository that ships the plugin`, () => {
    const box = harness("", {
      list: '[{"number":7}]',
      rollup: READY,
      body: CLEAN,
      message,
      pluginSource: true,
    });
    const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

    assert.equal(ran.status, 2, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /non-compliant: acme\/other#7/);
    assert.equal(ran.labelled, false, `a pull request was labelled despite ${what}`);
  });
}

test("a repository whose open pull requests cannot be read is refused, not read as having none", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN, listFails: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /could not list the open pull requests of acme\/other/);
  assert.equal(ran.labelled, false, "the pull request was labelled on an unreadable survey");
});

test("the sibling survey reads over REST, so a branch hands off while GraphQL refuses", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.doesNotMatch(ran.calls, /^pr list/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/pulls /m);
});

test("the sibling survey scopes the head filter to the owner, which GitHub needs to filter at all", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.calls, /^api -X GET repos\/acme\/thing\/pulls -f head=acme:lane\/x -f state=open\b/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/pulls -f head=acme:lane\/x -f state=open\b/m);
});

function countCalls(calls: string, line: string): number {
  return calls.split("\n").filter((c) => c === line).length;
}

test("every read and write on the labelling path is REST, so a branch hands off while GraphQL refuses everything", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.doesNotMatch(ran.calls, /^pr /m);
  assert.doesNotMatch(ran.calls, /^label list/m);
  assert.match(ran.calls, /^api repos\/acme\/other\/pulls\/7$/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/pulls\/7\/commits --paginate --slurp -F per_page=100$/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/commits\/[0-9a-f]{40}\/check-runs --paginate --slurp -F per_page=100$/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/commits\/[0-9a-f]{40}\/status --paginate --slurp -F per_page=100$/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/labels --paginate --slurp -F per_page=100$/m);
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels -f labels\[\]=lane-verified$/m);
  assert.match(ran.calls, /^api -X GET repos\/acme\/other\/issues\/7\/labels --paginate --slurp -F per_page=100$/m);
});

test("a rate-limited read of the pull request is retried and the label still lands", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    true,
    { GH_STUB_THROTTLE: "api repos/acme/other/pulls/7", GH_STUB_THROTTLE_TIMES: "2" },
  );

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.match(ran.stderr, /gh api repos\/acme\/other\/pulls\/7 was rate limited on attempt 1 of 5 - waiting 0s/);
  assert.match(ran.stderr, /was rate limited on attempt 2 of 5 - waiting 0s/);
  assert.equal(countCalls(ran.calls, "api repos/acme/other/pulls/7"), 3, ran.calls);
  assert.equal(ran.labelled, true, "the label was never written after the read recovered");
});

test("a rate-limited label write is retried and read back, not reported as half-labelled", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    true,
    { GH_STUB_THROTTLE: "api -X POST repos/acme/other/issues/7/labels" },
  );

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.doesNotMatch(ran.stdout, /half-labelled/);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.equal(countCalls(ran.calls, "api -X POST repos/acme/other/issues/7/labels -f labels[]=lane-verified"), 2, ran.calls);
});

test("a read still rate limited after every retry is refused with nothing labelled", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    true,
    { GH_STUB_THROTTLE: "api repos/acme/other/pulls/7", GH_STUB_THROTTLE_TIMES: "99", LANE_HANDOFF_REST_TRIES: "3" },
  );

  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /read an EMPTY body for acme\/other#7/);
  assert.match(ran.stderr, /gh said: gh: API rate limit exceeded for user ID 7195135/);
  assert.equal(countCalls(ran.calls, "api repos/acme/other/pulls/7"), 3, ran.calls);
  assert.equal(ran.labelled, false, "a pull request was labelled with its text never read");
});

test("the backoff between retries grows from the configured base", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN });
  const began = Date.now();
  const ran = handoff(
    box,
    [...required(box), "--issue", "acme-1", "--note-file", box.notePath],
    true,
    { GH_STUB_THROTTLE: "api repos/acme/other/pulls/7", GH_STUB_THROTTLE_TIMES: "2", LANE_HANDOFF_REST_BACKOFF: "1" },
  );

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /attempt 1 of 5 - waiting 1s/);
  assert.match(ran.stderr, /attempt 2 of 5 - waiting 2s/);
  assert.ok(Date.now() - began >= 3000, "the retries did not wait the 1s and 2s they announced");
});

test("a repository the config names with no pull request on the branch is not labelled", () => {
  const box = harness("", { list: "[]", rollup: READY, body: CLEAN });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /handed off: acme\/thing#14/);
  assert.doesNotMatch(ran.stdout, /also labelled/);
  assert.doesNotMatch(ran.calls, /^api -X POST repos\/acme\/other\/issues\/\d+\/labels /m);
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
    ran.calls.indexOf("label create") < ran.calls.indexOf("api -X POST"),
    `the label was created after the first pull request was labelled:\n${ran.calls}`,
  );
});

test("a sibling whose only near-match is a different label gets the label created", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, labelSimilar: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /created the lane-verified label in acme\/other/);
  assert.ok(
    ran.calls.indexOf("label create") < ran.calls.indexOf("api -X POST"),
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
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels /m);
});

test("a configured repository with no slug has one read from its own origin", () => {
  const box = harness("", { list: '[{"number":7}]', rollup: READY, body: CLEAN, noSlug: true });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
  assert.match(ran.calls, /^api -X POST repos\/acme\/other\/issues\/7\/labels /m);
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
  assert.match(ran.calls, /^api -X GET repos\/acme\/thing\/pulls\/14\/commits /m);
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
  assert.match(ran.stderr, /gh said: \{"message":"Not Found","status":"404"\}/);
  assert.equal(countCalls(ran.calls, `api repos/acme/thing/git/ref/heads/${BRANCH}`), 1, ran.calls);
  assert.doesNotMatch(ran.stdout, /not-green/);
  assert.equal(ran.labelled, false, "a pull request was labelled on an unreadable head sha");
});

test("a second repository's commit statuses are read, not reported as a rollup that did not parse", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: "[]",
    statuses: '[{"context":"codecov/project","state":"success"}]',
    body: CLEAN,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.doesNotMatch(ran.stdout, /unreadable/);
  assert.match(ran.stdout, /also labelled lane-verified on lane\/x: acme\/other#7/);
});

test("a second repository's failed commit status is not-green and names the context", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: READY,
    statuses: '[{"context":"codecov/project","state":"failure"}]',
    body: CLEAN,
    mergeable: true,
    mergeState: "clean",
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 4, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /not-green: BAD:codecov\/project on acme\/other#7/);
  assert.doesNotMatch(ran.stdout, /unreadable/);
  assert.equal(ran.labelled, false, "a pull request with a failed commit status was labelled");
});

test("a second repository's pending commit status is not-green, not unreadable", () => {
  const box = harness("", {
    list: '[{"number":7}]',
    rollup: "[]",
    statuses: '[{"context":"codecov/project","state":"pending"}]',
    body: CLEAN,
  });
  const ran = handoff(box, [...required(box), "--issue", "acme-1", "--note-file", box.notePath], true);

  assert.equal(ran.status, 4, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /not-green: BAD:codecov\/project on acme\/other#7/);
  assert.doesNotMatch(ran.stdout, /unreadable/);
  assert.equal(ran.labelled, false, "a pull request with a pending commit status was labelled");
});

test("a flag that takes a value is refused when given none, not looped on forever", () => {
  const box = harness("");
  const flags = ["--repo-path", "--slug", "--pr", "--branch", "--issue", "--note-file", "--worktree", "--lane-lock", "--label"];
  for (const flag of flags) {
    const ran = handoff(box, [...required(box), flag], true, {}, 5000);

    assert.equal(ran.signal, null, `${flag}: the script had to be killed`);
    assert.equal(ran.status, 6, `${flag}: ${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, new RegExp(`${flag} needs a value`));
    assert.equal(ran.labelled, false, `${flag}: the pull request was labelled despite the refusal`);
  }
});

const LANE = "lane/probe";

function localBranch(message: string | null, opts: { pushed?: boolean; pluginSource?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-prepush-"));
  const remote = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--bare", "--quiet", remote);
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.email", "nobody@example.invalid");
  git(repo, "config", "user.name", "Nobody");
  git(repo, "remote", "add", "origin", remote);
  if (opts.pluginSource) plantPluginSource(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/master");
  git(repo, "fetch", "--quiet", "origin");
  git(repo, "checkout", "--quiet", "-b", LANE);
  if (message !== null) {
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "--quiet", "-m", message);
  }
  if (opts.pushed) {
    publish(repo);
  }
  return repo;
}

function publish(repo: string): void {
  git(repo, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${LANE}`);
  git(repo, "fetch", "--quiet", "origin");
}

function commitOn(repo: string, message: string, opts: { pushed?: boolean } = {}): string {
  writeFileSync(join(repo, "a.txt"), `${message}\n`);
  git(repo, "add", "a.txt");
  git(repo, "commit", "--quiet", "-m", message);
  const head = git(repo, "rev-parse", "HEAD");
  if (opts.pushed) {
    publish(repo);
  }
  return head;
}

function rebaseOntoMovedMaster(repo: string): void {
  const lane = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "master");
  writeFileSync(join(repo, "b.txt"), "master moved on\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "--quiet", "-m", "A commit master landed underneath");
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/master");
  git(repo, "fetch", "--quiet", "origin");
  git(repo, "checkout", "--quiet", LANE);
  git(repo, "rebase", "--quiet", "origin/master");
  assert.notEqual(
    git(repo, "rev-parse", "HEAD"),
    lane,
    "the rebase replayed nothing, so the shape this test needs was never built",
  );
}

function prePush(repo: string, ...extra: string[]): { status: number; stdout: string; stderr: string; calls: string } {
  const bin = mkdtempSync(join(tmpdir(), "pitwall-prepush-bin-"));
  const ghLog = join(bin, "gh.log");
  executable(join(bin, "gh"), ["#!/bin/sh", `printf '%s\\n' "$*" >> "${ghLog}"`, "exit 1", ""].join("\n"));
  const ran = spawnSync("bash", [SCRIPT, "--repo-path", repo, "--pre-push", ...extra], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
  });
  let calls = "";
  try {
    calls = readFileSync(ghLog, "utf8");
  } catch {
    calls = "";
  }
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "", calls };
}

test("a local commit message quoting the handoff label token is caught before any push", () => {
  const repo = localBranch(
    [
      "Refuse to label a branch whose commit message quotes it",
      "",
      "The check greps for the literal lane-verified token, so typesetting changes nothing.",
    ].join("\n"),
  );
  const ran = prePush(repo);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant commits: nothing has been pushed/);
  assert.match(ran.stdout, /lane-verified/);
  assert.match(ran.stdout, /commit --amend/);
  assert.equal(ran.calls, "", "the pre-push check reached for a pull request that cannot exist yet");
});

test("every remedy the pre-push refusal prints carries the identity to commit with", () => {
  const ran = prePush(localBranch("Read the token back\n\nThe gate greps for lane-verified itself."));
  const commands = ran.stdout.split("\n").filter((line) => /\bgit\b.*\bcommit\b/.test(line));

  assert.ok(
    commands.length >= 2,
    `the refusal printed fewer than the two remedies it describes. Offered: ${ran.stdout}`,
  );
  for (const line of commands) {
    assert.match(
      line,
      /user\.name=/,
      `a remedy commits with no name to commit under. A lane resolves no git identity of its own, ` +
        `so git stamps a hostname-derived one and that author reaches master: ${line}`,
    );
    assert.match(
      line,
      /user\.email=/,
      `a remedy commits with no address to commit under, so the author git invents from the ` +
        `hostname is the one GitHub displays on master: ${line}`,
    );
  }
  assert.ok(
    commands.some((line) => line.includes("--amend")),
    `no remedy for a hit in the tip commit. Offered: ${ran.stdout}`,
  );
  assert.ok(
    commands.some((line) => line.includes("reset --soft origin/master")),
    `no remedy for a hit below the tip commit. Offered: ${ran.stdout}`,
  );
});

test("the pre-push refusal says to run it again once the message is reworded", () => {
  const ran = prePush(localBranch("Quote the label\n\nA commit body naming lane-verified outright."));

  assert.match(
    ran.stdout,
    /RUN THIS AGAIN/i,
    `the refusal ends without asking for a re-read, so a run can amend and push without anything ` +
      `having graded the message it just wrote. Offered: ${ran.stdout}`,
  );
});

test("a local commit claiming a machine author is caught before any push", () => {
  const ran = prePush(localBranch("Regenerate the artwork\n\nGenerated with an assistant."));

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant commits/);
});

test("a clean local commit passes the pre-push check with no pull request to read", () => {
  const repo = localBranch(
    [
      "Grade the pull request body and the commit messages apart",
      "",
      "One half is fixable in place and the other is not, so the refusal now says which.",
    ].join("\n"),
  );
  const ran = prePush(repo);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /compliant commits: origin\/master\.\.HEAD/);
  assert.doesNotMatch(ran.stdout, /non-compliant/);
  assert.equal(ran.calls, "", "the pre-push check reached for a pull request that cannot exist yet");
});

test("a local commit naming the plugin passes the pre-push check in the repository that ships it", () => {
  const ran = prePush(localBranch(PLUGIN_NOUN, { pluginSource: true }));

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /compliant commits/);
});

test("a local commit naming the plugin is caught before any push in a repository that does not ship it", () => {
  const ran = prePush(localBranch(PLUGIN_NOUN));

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant commits/);
  assert.match(ran.stdout, /DEVLOOP_ROOT/);
});

test("a local commit quoting the handoff label token is caught in the repository that ships the plugin", () => {
  const ran = prePush(localBranch("Read the token back\n\nThe gate greps for lane-verified itself.", { pluginSource: true }));

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant commits/);
});

test("a local commit naming a scratch path is caught in the repository that ships the plugin", () => {
  const ran = prePush(localBranch("Capture the board\n\nWritten under /tmp/lanes/acme-14/repo, then /private/tmp/shots.", { pluginSource: true }));

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /non-compliant commits/);
});

test("a HEAD that is not ahead of origin/master is refused rather than reported clean", () => {
  const ran = prePush(localBranch(null));

  assert.notEqual(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /not ahead of origin\/master/);
  assert.doesNotMatch(ran.stdout, /compliant commits/);
});

test("a hit in a commit a remote ref already reaches is never called local, and never squashed", () => {
  const ran = prePush(
    localBranch("Refuse a branch quoting lane-verified in its message", { pushed: true }),
  );

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.doesNotMatch(
    ran.stdout,
    /nothing has been pushed/,
    `the check asserted the branch is local without ever reading a remote ref. Every attempt ` +
      `after the first arrives on a branch whose commits are already pushed, which is the only ` +
      `state this refusal matters in. Offered: ${ran.stdout}`,
  );
  assert.ok(
    !ran.stdout.includes("reset --soft origin/master"),
    `the check offered to collapse the range to origin/master with a pushed commit at or below ` +
      `the hit. Following that squashes the pushed commits too, the push is then refused as a ` +
      `non-fast-forward, and the only way on is the force-push a run may not make - the exact ` +
      `dead end this check exists to remove. Offered: ${ran.stdout}`,
  );
  assert.ok(
    ran.stdout.includes("NEEDS A PERSON"),
    `a hit in a pushed commit got no verdict, so a run reads it as fixable and rewrites history ` +
      `that a remote ref points at. Offered: ${ran.stdout}`,
  );
  assert.match(
    ran.stdout,
    /Refuse a branch quoting/,
    `the refusal does not say which commit the hit is in, so a person cannot act on the report ` +
      `it asks for. Offered: ${ran.stdout}`,
  );
});

test("a hit in an unpushed commit above a pushed one is squashed no further than the pushed head", () => {
  const repo = localBranch("A first commit nothing objects to", { pushed: true });
  const pushedHead = git(repo, "rev-parse", "--short", "HEAD");
  commitOn(repo, "A later commit naming lane-verified outright");
  const ran = prePush(repo);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.ok(
    !ran.stdout.includes("reset --soft origin/master"),
    `the deeper remedy reaches past the commit already on the remote. Offered: ${ran.stdout}`,
  );
  assert.ok(
    ran.stdout.includes(`reset --soft ${pushedHead}`),
    `the deeper remedy does not name the pushed head as its base, so a hit below the tip has no ` +
      `remedy a run can follow at all. Offered: ${ran.stdout}`,
  );
  assert.doesNotMatch(ran.stdout, /nothing has been pushed/, ran.stdout);
});

test("after a rebase the only remedy offered is an amend of the commit the step just wrote", () => {
  const repo = localBranch("A reviewed commit nothing objects to");
  commitOn(repo, "A repair commit naming lane-verified outright");
  const ran = prePush(repo, "--rebased");

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.ok(
    ran.stdout.includes("commit --amend"),
    `no remedy for the commit this step wrote, which is the one commit a rebase path may amend ` +
      `for free. Offered: ${ran.stdout}`,
  );
  assert.ok(
    !ran.stdout.includes("reset --soft"),
    `a squash was offered on a rebased range. Every sha there is new, so absence from a remote ` +
      `says nothing about what was reviewed, and the commits underneath were - collapsing them ` +
      `throws away reviewed messages. Offered: ${ran.stdout}`,
  );
  assert.doesNotMatch(
    ran.stdout,
    /nothing has been pushed/,
    `a rebased branch IS pushed - only its shas are new. Offered: ${ran.stdout}`,
  );
});

test("after a rebase a hit underneath the new commit is a report rather than a squash", () => {
  const repo = localBranch("A reviewed commit naming lane-verified outright");
  commitOn(repo, "A repair commit nothing objects to");
  const ran = prePush(repo, "--rebased");

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.ok(
    ran.stdout.includes("NEEDS A PERSON"),
    `a hit in a reviewed commit underneath got no verdict. Offered: ${ran.stdout}`,
  );
  assert.ok(
    !ran.stdout.includes("reset --soft") && !ran.stdout.includes("commit --amend"),
    `a remedy was offered for a commit this step did not write. Offered: ${ran.stdout}`,
  );
  assert.match(ran.stdout, /A reviewed commit naming/, ran.stdout);
});

test("--rebased is refused outside the pre-push modes rather than silently ignored", () => {
  const ran = spawnSync(
    "bash",
    [SCRIPT, "--repo-path", localBranch("A commit"), "--slug", "owner/name", "--pr", "1", "--branch", "x", "--rebased"],
    { encoding: "utf8", env: { ...process.env, ...GIT_ENV } },
  );

  assert.equal(ran.status, 6, (ran.stdout ?? "") + (ran.stderr ?? ""));
  assert.match(ran.stderr ?? "", /--rebased/);
});

test("a rebased branch the remote already holds is never reported as never pushed", () => {
  const repo = localBranch("A reviewed commit nothing objects to", { pushed: true });
  rebaseOntoMovedMaster(repo);
  const ran = prePush(repo);

  assert.doesNotMatch(
    ran.stdout + ran.stderr,
    /nothing has been pushed/,
    `a rebase renews every sha, so nothing on the branch is reachable from a remote ref and the ` +
      `old reachability proxy read a four-times-pushed branch as local. The remote still holds ` +
      `the branch, and it is the remote that knows. Offered: ${ran.stdout}${ran.stderr}`,
  );
  assert.notEqual(
    ran.status,
    0,
    `the check cleared a push that cannot be made: HEAD does not contain the head the remote ` +
      `holds, so a plain push is rejected as a non-fast-forward and only a force-push follows - ` +
      `the dead end this check exists to remove, reached through the check itself. ` +
      `Offered: ${ran.stdout}${ran.stderr}`,
  );
  assert.doesNotMatch(
    ran.stdout,
    /safe to push/,
    `the check called the push safe on a branch it cannot fast-forward. Offered: ${ran.stdout}`,
  );
  assert.equal(ran.status, 10, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /published/, ran.stdout);
  assert.match(ran.stdout, new RegExp(LANE), ran.stdout);
  assert.ok(
    !ran.stdout.includes("reset --soft") && !ran.stdout.includes("commit --amend"),
    `a remedy was printed for a branch the remote holds at a head HEAD does not contain. Every ` +
      `one of them ends in a force-push. Offered: ${ran.stdout}`,
  );
});

test("a hit on a rebased branch the remote holds gets a verdict, not an amend", () => {
  const repo = localBranch("A reviewed commit naming lane-verified outright", { pushed: true });
  rebaseOntoMovedMaster(repo);
  const ran = prePush(repo);

  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.ok(
    ran.stdout.includes("NEEDS A PERSON"),
    `a hit on a published-then-rewritten branch got no verdict, so a run reads it as fixable and ` +
      `amends its way into a push nothing will accept. Offered: ${ran.stdout}`,
  );
  assert.ok(
    !ran.stdout.includes("reset --soft") && !ran.stdout.includes("commit --amend"),
    `a remedy was offered where every route out rewrites what the remote already holds. ` +
      `Offered: ${ran.stdout}`,
  );
  assert.match(ran.stdout, /A reviewed commit naming/, ran.stdout);
  assert.doesNotMatch(ran.stdout, /nothing has been pushed/, ran.stdout);
});

test("a remote that cannot be asked whether the branch exists is refused, not read as local", () => {
  const repo = localBranch("A commit naming lane-verified outright");
  git(repo, "remote", "set-url", "origin", join(repo, "no-such-remote.git"));
  const ran = prePush(repo);

  assert.notEqual(
    ran.status,
    2,
    `an unreachable remote was graded as a branch that does not exist on it. Silence is not ` +
      `absence: taken as absence the check prints an amend and a squash a later push refuses, ` +
      `which is the old proxy's failure in a new coat. Offered: ${ran.stdout}${ran.stderr}`,
  );
  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /ls-remote/, ran.stderr);
  assert.doesNotMatch(ran.stdout, /compliant commits/, ran.stdout);
  assert.doesNotMatch(ran.stdout, /nothing has been pushed/, ran.stdout);
});

test("a detached HEAD with no branch to ask the remote about is refused", () => {
  const repo = localBranch("A commit nothing objects to");
  git(repo, "checkout", "--quiet", "--detach", "HEAD");
  const ran = prePush(repo);

  assert.equal(ran.status, 6, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /--branch/, ran.stderr);
  assert.doesNotMatch(ran.stdout, /compliant commits/, ran.stdout);
});

test("--branch is what the remote is asked about when HEAD carries no name", () => {
  const repo = localBranch("A reviewed commit nothing objects to", { pushed: true });
  rebaseOntoMovedMaster(repo);
  git(repo, "checkout", "--quiet", "--detach", "HEAD");
  const ran = prePush(repo, "--branch", LANE);

  assert.equal(
    ran.status,
    10,
    `a detached HEAD given the branch name still could not establish that the remote holds it, ` +
      `so the one caller that cannot rely on symbolic-ref has no way to be told the truth. ` +
      `Offered: ${ran.stdout}${ran.stderr}`,
  );
  assert.doesNotMatch(ran.stdout, /nothing has been pushed/, ran.stdout);
});

test("--rebased grades a detached HEAD without asking any remote anything", () => {
  const repo = localBranch("A reviewed commit nothing objects to", { pushed: true });
  rebaseOntoMovedMaster(repo);
  commitOn(repo, "A repair commit naming lane-verified outright");
  git(repo, "checkout", "--quiet", "--detach", "HEAD");
  git(repo, "remote", "set-url", "origin", join(repo, "no-such-remote.git"));
  const ran = prePush(repo, "--rebased");

  assert.equal(
    ran.status,
    2,
    `the rebase path could not grade its own commit. It runs on a detached HEAD and it ` +
      `force-pushes by design, so it has no branch name to offer and no need of one - ` +
      `demanding a remote answer there breaks the one caller that legitimately republishes. ` +
      `Offered: ${ran.stdout}${ran.stderr}`,
  );
  assert.ok(
    ran.stdout.includes("commit --amend"),
    `no remedy for the commit this step wrote. Offered: ${ran.stdout}`,
  );
  assert.doesNotMatch(ran.stderr, /ls-remote/, ran.stderr);
  assert.doesNotMatch(ran.stderr, /--branch/, ran.stderr);
});
