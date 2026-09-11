import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// THE WORKFLOW RUNNER IS THE ONLY THING THAT LOADS THESE FILES, AND `node --check` DOES NOT
// SPEAK FOR IT.
//
// task.js hands a run its brief as one large template literal. An unescaped backtick inside
// that text closes the literal early: the file stays valid JavaScript - `node --check` reports
// it fine - and becomes a different program. The Workflow parser rejects it, so the failure
// appears at dispatch, as "Invalid workflow script", with every lane blocked.
//
// That happened on 2026-09-09: a rule written as 12. EVERY `gh pr` COMMAND ... carried four
// backticks into the brief and no lane could start until it was reverted. Both `node --check`
// and CI passed the whole time.
//
// So this asserts the invariant directly rather than trusting a parser to notice: the prompt
// templates contain no backticks at all. Quote spans with 'single quotes' instead - correct,
// and it does not invite the next person to make the same mistake with an escape.
const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

function bodyOfRulesTemplate(source: string): string {
  const start = source.indexOf("0. WRITE bd TEXT THROUGH A FILE");
  assert.notEqual(start, -1, "the rules block moved - update this test rather than deleting it");
  const end = source.indexOf("\n`", start);
  assert.notEqual(end, -1, "could not find the end of the rules template");
  return source.slice(start, end);
}

test("the rules a run is given carry no backticks", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  const rules = bodyOfRulesTemplate(source);
  const found = rules.split("\n").filter((line) => line.includes("`"));
  assert.deepEqual(
    found,
    [],
    `a backtick inside the brief closes its template literal early. Use 'single quotes':\n${found.join("\n")}`,
  );
});

function standingShellBlock(source: string, file: string): string {
  const start = source.indexOf("const SHELL_FIRST = ");
  assert.notEqual(
    start,
    -1,
    `${file} hands a run git and bundler commands but no longer tells it to export past an ` +
      "unreadable home-directory config. Every git command fails and every bundler-fronted " +
      "command hangs when that file cannot be read, and the hang is silent.",
  );
  const body = start + "const SHELL_FIRST = `".length;
  const end = source.indexOf("`\n", body);
  assert.notEqual(end, -1, `the standing shell block in ${file} has no end`);
  return source.slice(body, end);
}

test("the standing shell block carries no backticks in any script that hands it out", () => {
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js"]) {
    const block = standingShellBlock(readFileSync(join(SKILL, file), "utf8"), file);
    const found = block.split("\n").filter((line) => line.includes("`"));
    assert.deepEqual(
      found,
      [],
      `a backtick inside ${file} closes its template literal early. Use 'single quotes':\n${found.join("\n")}`,
    );
    assert.ok(
      block.includes("export GIT_CONFIG_GLOBAL=/dev/null BUNDLE_USER_CONFIG=/dev/null"),
      `${file} names the block but no longer carries both exports`,
    );
  }
});

const WRITES_A_COMMIT = /(^\s*|&&\s*|\|\|\s*|;\s*)(if ! )?git\s+(-C\s+\S+\s+)?(commit|rebase|cherry-pick|merge)(?![-\w])/;

test("nothing in the plugin commits or rebases on an identity it did not pass", () => {
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "land-train.sh", "land-one.sh"]) {
    const source = readFileSync(join(SKILL, file), "utf8");
    const writes = source
      .split("\n")
      .map((line, i) => ({ line, at: i + 1 }))
      .filter(({ line }) => WRITES_A_COMMIT.test(line))
      .filter(({ line }) => !/--(abort|skip)\b/.test(line))
      .filter(({ line }) => !/user\.name=/.test(line));
    assert.deepEqual(
      writes.map(({ line, at }) => `${file}:${at}${line}`),
      [],
      "a command that writes a commit takes its identity from config the run has told git not to " +
        "read. git then refuses the commit, or invents a name from the machine account - and the " +
        "caller reports that as 'commit refused' or, worse, as a conflict with master.",
    );
  }
});

test("every workflow script is present in the plugin", () => {
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "config.sh", "lock-check.sh", "lane-running.sh"]) {
    const path = join(SKILL, file);
    assert.doesNotThrow(() => readFileSync(path), `${file} is missing from the published plugin`);
  }
});
