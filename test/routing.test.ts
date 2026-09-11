import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const CONFIG_SH = join(SKILL, "config.sh");
const QUEUE_SH = join(SKILL, "queue.sh");
const SLOT_SH = join(SKILL, "slot.sh");
const DISPATCHABLE_SH = join(SKILL, "dispatchable.sh");

const SESSION = "zz-devloop";

interface Issue {
  id: string;
  title: string;
  priority: number;
  status?: string;
  assignee?: string;
  labels?: string[];
}

interface Harness {
  root: string;
  bin: string;
  config: string;
  prefix: string;
  issues: string;
  calls: string;
}

let sequence = 0;

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function harness(
  issues: Issue[],
  options: { refuseEveryClaim?: boolean; sessions?: boolean; slug?: string; trusted?: string[] } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-routing-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  const prefix = `pwrouting${process.pid}x${(sequence += 1)}`;
  const config = join(root, ".pitwall.json");
  writeFileSync(
    config,
    JSON.stringify({
      root,
      idPrefix: "zz",
      lockPrefix: prefix,
      lanes: 3,
      ...(options.sessions === false ? {} : { sessions: { devloop: SESSION, planning: "zz-planning-session" } }),
      ...(options.trusted ? { trustedIssueAuthors: options.trusted } : {}),
      repos: { site: { path: "repo", test: "npm test", ...(options.slug ? { slug: options.slug } : {}) } },
    }),
  );

  const issuesFile = join(root, "issues.json");
  writeFileSync(
    issuesFile,
    JSON.stringify(issues.map((i) => ({ status: "open", issue_type: "task", ...i }))),
  );
  const calls = join(root, "calls.txt");
  writeFileSync(calls, "");

  executable(
    join(bin, "bd"),
    [
      "#!/bin/bash",
      'actor=""',
      'if [ "$1" = "--actor" ]; then actor="$2"; shift 2; fi',
      'cmd="$1"; shift',
      'case "$cmd" in',
      "  list)",
      '    status=open',
      '    while [ $# -gt 0 ]; do [ "$1" = "--status" ] && status="$2"; shift; done',
      '    python3 -c "',
      "import json, sys",
      "want = sys.argv[2].split(',')",
      "rows = json.load(open(sys.argv[1]))",
      "print(json.dumps([r for r in rows if r.get('status') in want]))",
      '" "$BD_ISSUES" "$status"',
      "    ;;",
      "  blocked)",
      "    echo '[]'",
      "    ;;",
      "  ready)",
      '    want=""',
      '    while [ $# -gt 0 ]; do [ "$1" = "-a" ] && want="$2"; shift; done',
      '    python3 -c "',
      "import json, sys",
      "rows = [r for r in json.load(open(sys.argv[1])) if r.get('status') == 'open']",
      "want = sys.argv[2]",
      "if want: rows = [r for r in rows if (r.get('assignee') or '') == want]",
      "print(json.dumps(rows))",
      '" "$BD_ISSUES" "$want"',
      "    ;;",
      "  show)",
      '    if [ "${BD_SHOW_BROKEN:-0}" = "1" ]; then echo "bd: database is locked" >&2; exit 1; fi',
      '    python3 -c "',
      "import json, sys",
      "rows = [r for r in json.load(open(sys.argv[1])) if r['id'] == sys.argv[2]]",
      "print(json.dumps(rows[0] if rows else {}))",
      '" "$BD_ISSUES" "$1"',
      "    ;;",
      "  update)",
      '    id="$1"; shift',
      '    printf \'%s actor=%s %s\\n\' "$id" "$actor" "$*" >> "$BD_CALLS"',
      '    if [ "${BD_REFUSE:-0}" = "1" ]; then',
      '      echo "Error claiming $id: issue already claimed by somebody-else" >&2',
      "      exit 1",
      "    fi",
      '    holder="$(python3 -c "',
      "import json, sys",
      "rows = [r for r in json.load(open(sys.argv[1])) if r['id'] == sys.argv[2]]",
      "print((rows[0].get('assignee') or '') if rows else '')",
      '" "$BD_ISSUES" "$id")"',
      '    case " $* " in',
      "      *--claim*)",
      '        if [ -n "$holder" ] && [ "$holder" != "$actor" ]; then',
      '          echo "Error claiming $id: issue already claimed by $holder" >&2',
      "          exit 1",
      "        fi",
      "        ;;",
      "    esac",
      '    echo "Updated issue: $id"',
      "    ;;",
      '  *) echo "bd stub: unhandled $cmd $*" >&2; exit 2 ;;',
      "esac",
      "",
    ].join("\n"),
  );

  executable(
    join(bin, "gh"),
    [
      "#!/bin/bash",
      'if [ "$1" = "issue" ]; then cat "${GH_ISSUES:-/dev/null}"; exit 0; fi',
      'if [ "$1" = "api" ]; then echo "${GH_ASSOC:-NONE}"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );

  return { root, bin, config, prefix, issues: issuesFile, calls };
}

function clean(box: Harness): void {
  rmSync(join(tmpdir(), `${box.prefix}-slots`), { recursive: true, force: true });
  rmSync(`/tmp/${box.prefix}-slots`, { recursive: true, force: true });
  rmSync(box.root, { recursive: true, force: true });
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function run(box: Harness, script: string, args: string[], extra: Record<string, string> = {}): Ran {
  const ran = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      BD_ISSUES: box.issues,
      BD_CALLS: box.calls,
      PITWALL_SESSION: "",
      ...extra,
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function handedOut(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => /^(\S+) (\d+)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1] as string);
}

function claimed(box: Harness): string[] {
  return readFileSync(box.calls, "utf8")
    .split("\n")
    .filter((line) => line.includes("--claim"))
    .map((line) => line.split(" ")[0] as string);
}

test("the queue hands out only what is assigned to this session", () => {
  const box = harness([
    { id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION },
    { id: "zz-bbb2", title: "nobody's", priority: 0 },
    { id: "zz-ccc3", title: "a person's", priority: 0, assignee: "Vladimir Elchinov" },
    { id: "zz-ddd4", title: "ours too", priority: 1, assignee: SESSION },
  ]);
  try {
    const ran = run(box, QUEUE_SH, ["--next", "4"]);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.deepEqual(handedOut(ran.stdout), ["zz-aaa1", "zz-ddd4"]);
    assert.deepEqual(
      claimed(box),
      ["zz-aaa1", "zz-ddd4"],
      "an unassigned issue must never even be claimed: unassigned plus a claim is how an issue " +
        "leaves this pipeline's queue stamped with whatever actor bd resolves",
    );
  } finally {
    clean(box);
  }
});

test("every claim names the session as bd's actor", () => {
  const box = harness([{ id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION }]);
  try {
    const ran = run(box, QUEUE_SH, ["--next", "1"]);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    const log = readFileSync(box.calls, "utf8").trim();
    assert.match(log, new RegExp(`^zz-aaa1 actor=${SESSION} `), log);
  } finally {
    clean(box);
  }
});

test("a queue that could not claim what was ready says so and fails", () => {
  const box = harness([{ id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION }]);
  try {
    const ran = run(box, QUEUE_SH, ["--next", "1"], { BD_REFUSE: "1" });
    assert.notEqual(ran.status, 0, "a refused claim with nothing handed out is a failure, not a quiet day");
    assert.deepEqual(handedOut(ran.stdout), []);
    assert.match(ran.stderr, /could NOT be claimed/);
    assert.match(ran.stderr, /zz-aaa1/);
    assert.match(ran.stderr, /already claimed by somebody-else/);
  } finally {
    clean(box);
  }
});

test("the unassigned are reported rather than silently dropped", () => {
  const box = harness([
    { id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION },
    { id: "zz-bbb2", title: "nobody's", priority: 0 },
  ]);
  try {
    const ran = run(box, QUEUE_SH, []);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /unassigned\s+1/);
    assert.match(ran.stdout, /zz-bbb2/);
  } finally {
    clean(box);
  }
});

test("a lane is not reserved for an issue in nobody's queue", () => {
  const box = harness([{ id: "zz-bbb2", title: "nobody's", priority: 0 }]);
  try {
    const ran = run(box, SLOT_SH, ["zz-bbb2"]);
    assert.equal(ran.status, 1, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /UNASSIGNED/);
    assert.match(ran.stderr, new RegExp(`-a ${SESSION}`));
  } finally {
    clean(box);
  }
});

test("a lane is not reserved for somebody else's queue", () => {
  const box = harness([{ id: "zz-ccc3", title: "a person's", priority: 0, assignee: "Vladimir Elchinov" }]);
  try {
    const ran = run(box, SLOT_SH, ["zz-ccc3"]);
    assert.equal(ran.status, 1, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /assigned to Vladimir Elchinov/);
  } finally {
    clean(box);
  }
});

test("a lane is reserved for an issue this session owns", () => {
  const box = harness([{ id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION }]);
  try {
    const ran = run(box, SLOT_SH, ["zz-aaa1"]);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.equal(ran.stdout.trim(), "1");
  } finally {
    clean(box);
  }
});

test("the session names come from the workspace, and an explicit pair wins", () => {
  const declared = harness([]);
  try {
    assert.equal(run(declared, CONFIG_SH, ["session"]).stdout.trim(), SESSION);
    assert.equal(run(declared, CONFIG_SH, ["planning-session"]).stdout.trim(), "zz-planning-session");
  } finally {
    clean(declared);
  }

  const derived = harness([], { sessions: false });
  try {
    const project = derived.root.split("/").pop();
    assert.equal(run(derived, CONFIG_SH, ["session"]).stdout.trim(), `${project}-devloop`);
    assert.equal(
      run(derived, CONFIG_SH, ["planning-session"]).stdout.trim(),
      `${project}-planning-session`,
      "the default is the workspace directory, not idPrefix: session-replay has idPrefix sr and " +
        "sessions named session-replay-devloop, so idPrefix would match nothing and starve the queue",
    );
  } finally {
    clean(derived);
  }
});

test("a parked hand-back names BOTH steps, because the assignee moved too", () => {
  const box = harness([
    {
      id: "zz-eee5",
      title: "answered, but handed back",
      priority: 0,
      assignee: "zz-planning-session",
      labels: ["needs-decision"],
    },
  ]);
  try {
    const ran = run(box, SLOT_SH, ["zz-eee5"]);
    assert.equal(ran.status, 1, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /label remove zz-eee5 needs-decision/);
    assert.match(
      ran.stderr,
      new RegExp(`update zz-eee5 -a ${SESSION}`),
      "removing the label is no longer sufficient: a hand-back moved the assignee, so a person who " +
        "follows only the label instruction retries and hits a second, different refusal with " +
        "nothing telling them why",
    );
    assert.match(ran.stderr, /assignee is now zz-planning-session/);
  } finally {
    clean(box);
  }
});

test("a gate that cannot read the issue refuses instead of reserving a lane", () => {
  const box = harness([{ id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION }]);
  try {
    const ran = run(box, SLOT_SH, ["zz-aaa1"], { BD_SHOW_BROKEN: "1" });
    assert.equal(
      ran.status,
      1,
      "an unreadable issue skipped both the park check and the assignee check in silence, so a " +
        "tracker that would not answer read exactly like an issue that passed - in the one gate " +
        "between a hand-typed id and a lane that merges and deploys",
    );
    assert.match(ran.stderr, /could not be read from bd/);
    assert.equal(ran.stdout.trim(), "", "no slot number may be printed for an issue nobody read");
  } finally {
    clean(box);
  }
});

const ELSEWHERE = "zz-dev-loop";

test("a queue whose work carries another name says so, and names it", () => {
  const box = harness([
    { id: "zz-aaa1", title: "theirs", priority: 0, assignee: ELSEWHERE },
    { id: "zz-bbb2", title: "theirs too", priority: 1, assignee: ELSEWHERE },
    { id: "zz-ccc3", title: "a person's", priority: 1, assignee: "Vladimir Elchinov" },
  ]);
  try {
    const ran = run(box, QUEUE_SH, []);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /NONE OF IT IS OURS/);
    assert.match(ran.stdout, new RegExp(`${ELSEWHERE}\\s+2`), ran.stdout);
    assert.doesNotMatch(
      ran.stdout,
      /every open issue needs a person, is blocked, or is claimed/,
      "three ready issues assigned to a name one hyphen away from this one is a configuration " +
        "fault, and reporting it as parking sends the reader to look at labels that are fine. " +
        "A workspace on this machine derives zz-devloop where its session is zz-dev-loop",
    );
  } finally {
    clean(box);
  }
});

test("dispatchable hands out this session's work and nothing else", () => {
  const box = harness([
    { id: "zz-aaa1", title: "ours", priority: 0, assignee: SESSION },
    { id: "zz-bbb2", title: "nobody's", priority: 0 },
    { id: "zz-ccc3", title: "theirs", priority: 0, assignee: ELSEWHERE },
  ]);
  try {
    const ran = run(box, DISPATCHABLE_SH, []);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /zz-aaa1/);
    assert.doesNotMatch(ran.stdout.split("UNASSIGNED")[0] as string, /zz-bbb2/);
    assert.doesNotMatch(ran.stdout, /zz-ccc3 +P/);
  } finally {
    clean(box);
  }
});

test("dispatchable blames the name, not the labels, when nothing carries this session's", () => {
  const box = harness([
    { id: "zz-aaa1", title: "theirs", priority: 0, assignee: ELSEWHERE },
    { id: "zz-bbb2", title: "theirs too", priority: 1, assignee: ELSEWHERE },
  ]);
  try {
    const ran = run(box, DISPATCHABLE_SH, []);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, new RegExp(`${ELSEWHERE}\\s+2`), ran.stdout);
    assert.match(ran.stdout, /sessions/);
    assert.doesNotMatch(
      ran.stdout,
      /is parked, an epic, or a parent/,
      "bd returned ready work and none of it is ours: that is the derived session name being " +
        "wrong, and attributing it to parking is the silent-starve shape this change exists to kill",
    );
  } finally {
    clean(box);
  }
});

const ISSUES_WATCH_SH = join(SKILL, "issues-watch.sh");

// A TITLE THAT WOULD RUN IF IT WERE NOT QUOTED. Backtick, $(...) and an apostrophe, because the
// title comes from a public issue and the recipe is meant to be pasted into a shell.
const HOSTILE_TITLE = "it's `id` and $(whoami) broken";

function watched(box: Harness, author: string): Ran {
  const feed = join(box.root, "gh-issues.json");
  writeFileSync(
    feed,
    JSON.stringify([
      { number: 7, title: HOSTILE_TITLE, author: { login: author }, url: "https://github.com/zz/zz/issues/7" },
    ]),
  );
  return run(box, ISSUES_WATCH_SH, ["--peek"], {
    GH_ISSUES: feed,
    DEVLOOP_ISSUE_STATE: join(box.root, "seen"),
  });
}

test("an imported issue is PARKED, not promoted", () => {
  const box = harness([], { slug: "zz/zz" });
  try {
    const ran = watched(box, "stranger");
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(
      ran.stdout,
      /-l needs-decision/,
      "IMPORT and PROMOTE must never be collapsed: the repositories are public, so a create with " +
        "no park label is a path from a stranger opening an issue to a lane that merges and deploys",
    );
    assert.match(ran.stdout, /--body-file/);
    assert.match(ran.stdout, /has been verified/, "an import records that nothing in it is verified");
    assert.match(ran.stdout, /OUTSIDE CONTRIBUTOR/, "and whose words it is");
    assert.match(ran.stdout, /label remove/, "with PROMOTE shown as the separate step a person takes");
  } finally {
    clean(box);
  }
});

test("a configured author's issue is imported parked as well", () => {
  const box = harness([], { slug: "zz/zz", trusted: ["insider"] });
  try {
    const ran = watched(box, "insider");
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /configured author/);
    assert.match(
      ran.stdout,
      /-l needs-decision/,
      "one rule for import, not two: a second path that skips the gate is the copy that drifts, " +
        "and the provenance body is where a configured author is distinguished instead",
    );
  } finally {
    clean(box);
  }
});

test("an untrusted issue title cannot execute when the printed recipe is pasted", () => {
  const box = harness([], { slug: "zz/zz" });
  try {
    const ran = watched(box, "stranger");
    const line = ran.stdout.split("\n").find((l) => l.includes("create ")) ?? "";
    assert.notEqual(line, "", ran.stdout);
    assert.match(
      line,
      /create 'it'\\''s `id` and \$\(whoami\) broken'/,
      "the title is untrusted text from a public issue: single-quoted with embedded quotes escaped, " +
        `so a backtick in it is not a command substitution the moment somebody pastes this:\n${line}`,
    );
    assert.doesNotMatch(line, /create "/, "a double-quoted title evaluates backticks and $(...) before bd sees it");
  } finally {
    clean(box);
  }
});
