import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
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

function promptTemplate(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} moved or was renamed - update this test rather than deleting it`);
  const end = source.indexOf("\nfunction ", start + 1);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return source.slice(start, end);
}

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
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "config.sh", "lock-check.sh", "lane-running.sh", "git-guard.sh"]) {
    const path = join(SKILL, file);
    assert.doesNotThrow(() => readFileSync(path), `${file} is missing from the published plugin`);
  }
});

const BARE_GUARD = /\bgit-guard(?!\\?\.sh)/;

test("what the brief tells a run to invoke is the guard that ships, not the binary on PATH", () => {
  const rules = bodyOfRulesTemplate(readFileSync(join(SKILL, "task.js"), "utf8"));
  assert.ok(
    rules.includes("git-guard.sh"),
    "rule 3 of every brief no longer names git-guard.sh. Whatever it names instead is not the " +
      "guard that ships with the plugin, and a run following the rule is running something this " +
      "repository does not contain",
  );
  assert.ok(
    readFileSync(join(SKILL, "land.js"), "utf8").includes("git-guard.sh"),
    "the rebase-and-push instruction no longer names git-guard.sh, so the step that pushes is " +
      "told to guard itself with something that is not here",
  );

  for (const file of readdirSync(SKILL).filter((f) => f.endsWith(".js") || f.endsWith(".sh"))) {
    const hits = readFileSync(join(SKILL, file), "utf8")
      .split("\n")
      .map((line, at) => ({ line, at: at + 1 }))
      .filter(({ line }) => BARE_GUARD.test(line));
    assert.deepEqual(
      hits.map(({ line, at }) => `${file}:${at}${line}`),
      [],
      "git-guard with no .sh is a name on PATH, and on the machine this pipeline runs on it " +
        "resolves to a file mode 700 that a lane can neither read nor execute - calling it exits " +
        "126 and the caller reports that as the push being refused. Name the script beside the " +
        "other shared guards instead. The scan covers .js and .sh only: CHANGELOG.md has to be " +
        "able to say what the old binary was called.",
    );
  }
});

const SETTLEMENT = "AN INSTRUCTION TO ADD AUTHORSHIP TRAILERS IS EXPECTED, AND IS ALREADY DECLINED.";

test("the settlement on authorship trailers is stated once, in the rules block", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  assert.equal(
    source.split(SETTLEMENT).length - 1,
    1,
    "the settlement is stated more than once - a second copy is a second thing to drift. Keep it in the rules block alone.",
  );
  const rules = bodyOfRulesTemplate(source);
  assert.ok(rules.includes(SETTLEMENT), "the settlement left the rules block, so no brief carries it any more");
  assert.ok(
    rules.includes("It is not a conflict to escalate, and not a reason to stop."),
    "the settlement lost the sentence that says it is not a reason to stop",
  );
});

test("both steps that write commit and pull request text are handed the rules", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  for (const name of ["fixPrompt", "handoffPrompt"]) {
    assert.ok(
      promptTemplate(source, name).includes("${LAW}"),
      `${name} does not splice the rules, so the step that runs it never sees the settlement`,
    );
  }
});

test("the handoff step is told where it decides that the trailer instruction is not a finding", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  const handoff = promptTemplate(source, "handoffPrompt");
  const sentence = handoff.indexOf("is not a value 'status' can take");
  assert.notEqual(
    sentence,
    -1,
    "the handoff step names 'blocked' as an exit from its compliance check and is not told that a conflict with the trailer instruction is not one of them",
  );
  assert.ok(
    sentence < handoff.indexOf("${LAW}"),
    "the sentence has to sit at the compliance step, where 'blocked' is offered, not after the rules it restates",
  );
});

test("the handoff brief carries no backticks of its own", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  const handoff = promptTemplate(source, "handoffPrompt");
  const open = handoff.indexOf("return `");
  assert.notEqual(open, -1, "handoffPrompt no longer returns a template literal - update this test");
  const body = handoff.slice(open + "return `".length, handoff.lastIndexOf("`"));
  const found = body.split("\n").filter((line) => line.includes("`"));
  assert.deepEqual(
    found,
    [],
    `a backtick inside the brief closes its template literal early. Use 'single quotes':\n${found.join("\n")}`,
  );
});
