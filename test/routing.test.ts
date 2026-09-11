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

const SESSION = "zz-devloop";

interface Issue {
  id: string;
  title: string;
  priority: number;
  status?: string;
  assignee?: string;
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

function harness(issues: Issue[], options: { refuseEveryClaim?: boolean; sessions?: boolean } = {}): Harness {
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
      repos: { site: { path: "repo", test: "npm test" } },
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
      "  show)",
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
