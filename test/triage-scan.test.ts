import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "triage-scan.sh",
);

const ISSUE = "pitwall-aaa";

interface Harness {
  root: string;
  bin: string;
  home: string;
  prefix: string;
  config: string;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function harness(mergedBranch: string): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-triage-scan-"));
  const prefix = `pwtriage${process.pid}${Math.floor(Math.random() * 1e6)}`;
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const dir of [join(workspace, ".beads"), join(workspace, "site"), bin, home]) {
    mkdirSync(dir, { recursive: true });
  }

  const config = join(workspace, ".pitwall.json");
  writeFileSync(
    config,
    JSON.stringify({
      root: workspace,
      idPrefix: "pitwall",
      lockPrefix: prefix,
      repos: { site: { path: "site", test: "npm test" } },
    }),
  );

  const issue = JSON.stringify({
    id: ISSUE,
    status: "in_progress",
    priority: 2,
    title: "A lane whose branch used the older prefix",
    labels: [],
    notes: "",
  });
  executable(
    join(bin, "bd"),
    [
      "#!/bin/sh",
      `ISSUE='${issue}'`,
      'case "$*" in',
      '  "list --status open --json"|"list --status closed --json") printf \'[]\\n\' ;;',
      "  \"list --status in_progress --json\"|\"list --json\") printf '[%s]\\n' \"$ISSUE\" ;;",
      "  *) printf '[]\\n' ;;",
      "esac",
      "",
    ].join("\n"),
  );

  executable(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *"--state merged"*) printf '%s\\n' "${mergedBranch}" ;;`,
      "  *) printf '' ;;",
      "esac",
      "",
    ].join("\n"),
  );

  return { root: workspace, bin, home, prefix, config };
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function scan(box: Harness, mark: boolean): Ran {
  const ran = spawnSync("bash", [SCRIPT], {
    cwd: box.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      HOME: box.home,
      DEVLOOP_ROOT: box.root,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      TRIAGE_MARK: mark ? "1" : "0",
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

const SHARED_TMP = "/tmp";

function seenPath(box: Harness): string {
  return join(SHARED_TMP, `${box.prefix}-triage-seen.json`);
}

function cleanup(box: Harness): void {
  for (const name of [
    "triage-seen.json",
    "ts-all.json",
    "ts-open.json",
    "ts-run.json",
    "ts-closed.json",
  ]) {
    rmSync(join(SHARED_TMP, `${box.prefix}-${name}`), { force: true });
  }
  rmSync(join(box.root, ".."), { recursive: true, force: true });
}

test("a merged pull request under an older branch prefix is not a dead lane", () => {
  const box = harness(`autofix/${ISSUE}`);
  try {
    const ran = scan(box, false);
    assert.ok(
      !ran.stdout.includes("E stale claim"),
      `an issue handed off on autofix/${ISSUE} was reported as a dead lane:\n${ran.stdout}`,
    );
    assert.ok(!ran.stdout.includes(ISSUE), ran.stdout);
  } finally {
    cleanup(box);
  }
});

test("a branch under no recognised prefix still reports its issue as a dead lane", () => {
  const box = harness("fix/build-before-test");
  try {
    const ran = scan(box, false);
    assert.match(ran.stdout, /E stale claim/);
    assert.ok(ran.stdout.includes(ISSUE), ran.stdout);
  } finally {
    cleanup(box);
  }
});

test("the seen state is keyed by workspace and never written under the installed skill", () => {
  const box = harness("fix/build-before-test");
  try {
    const ran = scan(box, true);
    assert.notEqual(ran.status, 3, ran.stderr);

    const seen = seenPath(box);
    assert.ok(existsSync(seen), `no seen state at ${seen}`);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(seen, "utf8"))), [ISSUE]);

    assert.ok(
      !existsSync(join(box.home, ".claude")),
      "the seen state was written under the skill's own install directory, which a plugin " +
        "update replaces and a rename orphans",
    );
  } finally {
    cleanup(box);
  }
});

test("a marked finding is carried rather than reported again", () => {
  const box = harness("fix/build-before-test");
  try {
    assert.match(scan(box, true).stdout, /E stale claim/);
    const again = scan(box, false);
    assert.ok(!again.stdout.includes("E stale claim"), again.stdout);
    assert.match(again.stdout, /CLEAN.*1 carried/);
  } finally {
    cleanup(box);
  }
});
