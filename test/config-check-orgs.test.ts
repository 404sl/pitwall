import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const CONFIG_SH = join(SKILL, "config.sh");

interface Box {
  root: string;
  bin: string;
  config: string;
}

function workspace(repos: Record<string, Record<string, unknown>>): Box {
  const root = mkdtempSync(join(tmpdir(), "pitwall-check-orgs-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ root, idPrefix: "zz", lockPrefix: `pworgs${process.pid}`, lanes: 2, repos }));
  writeFileSync(join(bin, "bd"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "bd"), 0o755);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"master"}}' ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { root, bin, config };
}

function check(box: Box, extra: Record<string, string | undefined>) {
  const ran = spawnSync("bash", [CONFIG_SH, "--check"], {
    encoding: "utf8",
    cwd: box.root,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
      PITWALL_CONFIG: box.config,
      BEADS_DIR: "",
      HOME: box.root,
      CLAUDE_CONFIG_DIR: undefined,
      PITWALL_HARNESS_SETTINGS: undefined,
      ...extra,
    },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function settingsFile(box: Box, rules: string[]): string {
  const path = join(box.root, "harness-settings.json");
  writeFileSync(path, JSON.stringify({ autoMode: { allow: rules } }, null, 2));
  return path;
}

const RULE_ACME = "Allow gh pr merge --repo acme/<name> when an earlier gh pr view queried labels and statusCheckRollup.";

test("--check prints both orgs of a two-org workspace and warns on the one the allow rules do not name, without refusing", () => {
  const box = workspace({
    site: { path: "repo", test: "npm test", slug: "acme/site" },
    api: { path: "repo", test: "npm test", slug: "beta/api" },
    workspace: { path: ".", role: "workspace" },
  });
  try {
    const settings = settingsFile(box, [RULE_ACME]);
    const ran = check(box, { PITWALL_HARNESS_SETTINGS: settings });
    assert.equal(ran.status, 0, `a missing org refused the config:\n${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /orgs: acme, beta - the merge and deploy exceptions/, ran.stdout);
    assert.match(ran.stdout, /must name each one as '--repo <org>\/'/, ran.stdout);
    assert.match(ran.stdout, new RegExp(`harness settings: read ${settings.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`), ran.stdout);
    assert.match(ran.stdout, /WARN: no allow rule in .* mentions '--repo beta\/'/, ran.stdout);
    assert.match(ran.stdout, /beta\/\* will be refused as \[Merge Without Review\]/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /mentions '--repo acme\/'/, `the covered org was reported missing:\n${ran.stdout}`);
    assert.doesNotMatch(ran.stdout, /every configured org is named/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /not checked/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /Allow gh pr merge/, `the settings file's contents were quoted:\n${ran.stdout}`);
    assert.match(ran.stdout, /config OK: 3 repos/, ran.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("--check finds the settings file under the home directory and prints no warning when the single org is covered", () => {
  const box = workspace({
    site: { path: "repo", test: "npm test", slug: "acme/site" },
    docs: { path: "repo", test: "npm test", slug: "acme/docs" },
  });
  try {
    mkdirSync(join(box.root, ".claude"));
    writeFileSync(join(box.root, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: [RULE_ACME] } }));
    const ran = check(box, {});
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /orgs: acme - the merge and deploy exceptions/, ran.stdout);
    assert.match(ran.stdout, /harness settings: read .*\.claude\/settings\.json/, ran.stdout);
    assert.match(ran.stdout, /harness settings: every configured org is named/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /WARN/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /not checked/, ran.stdout);
    assert.match(ran.stdout, /config OK: 2 repos/, ran.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("--check prints the reminder unconditionally when no settings file is readable, and takes no warning path", () => {
  const box = workspace({
    site: { path: "repo", test: "npm test", slug: "acme/site" },
    api: { path: "repo", test: "npm test", slug: "beta/api" },
  });
  try {
    const ran = check(box, {});
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /orgs: acme, beta - the merge and deploy exceptions/, ran.stdout);
    assert.match(ran.stdout, /harness settings: not checked - no readable file at .*\.claude\/settings\.json/, ran.stdout);
    assert.match(ran.stdout, /Confirm yourself that the merge and deploy exceptions name every org above/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /WARN/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /harness settings: read/, ran.stdout);
    assert.doesNotMatch(ran.stdout, /every configured org is named/, ran.stdout);
    assert.match(ran.stdout, /config OK: 2 repos/, ran.stdout);

    const pointed = check(box, { PITWALL_HARNESS_SETTINGS: join(box.root, "moved-away.json") });
    assert.equal(pointed.status, 0, pointed.stdout + pointed.stderr);
    assert.match(pointed.stdout, /harness settings: not checked - no readable file at .*moved-away\.json\./, pointed.stdout);
    assert.doesNotMatch(pointed.stdout, /WARN/, pointed.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("--check does not read the settings file, and says nothing about orgs, when no repo carries a slug", () => {
  const box = workspace({ site: { path: "repo", test: "npm test" } });
  try {
    const settings = settingsFile(box, []);
    const ran = check(box, { PITWALL_HARNESS_SETTINGS: settings });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.doesNotMatch(ran.stdout, /orgs:|harness settings|WARN/, ran.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
