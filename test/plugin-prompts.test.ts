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

test("every bd write a run is told to make names the actor", () => {
  const offenders: string[] = [];
  for (const file of ["task.js", "land.js", "land-train.js", "rework.js"]) {
    const lines = readFileSync(join(SKILL, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const text = line.trim();
      if (!/^(?:\d+\.\s*)?(?:cd [^&]*&&\s*)?(?:[A-Z_]+=\S+\s+)?bd\s/.test(text)) return;
      if (text.includes("--actor")) return;
      if (!/\bbd\s+(?:\S+\s+)*?(update|create|close|label)\b/.test(text)) return;
      offenders.push(`${file}:${index + 1} ${text}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "a bd write with no --actor falls through to git user.name: on an issue this pipeline owns " +
      "the claim is refused, and on an unassigned one the write silently stamps a person as the " +
      "assignee, which takes the issue out of the queue for good. The flag has to appear in the " +
      `TEXT a run is handed, not only in the script that renders it:\n${offenders.join("\n")}`,
  );
});

test("every workflow script is present in the plugin", () => {
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "config.sh", "lock-check.sh", "lane-running.sh"]) {
    const path = join(SKILL, file);
    assert.doesNotThrow(() => readFileSync(path), `${file} is missing from the published plugin`);
  }
});
