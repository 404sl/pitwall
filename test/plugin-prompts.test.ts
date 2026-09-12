import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runScript } from "./support/workflow.js";

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
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "config.sh", "lock-check.sh", "lane-running.sh"]) {
    const path = join(SKILL, file);
    assert.doesNotThrow(() => readFileSync(path), `${file} is missing from the published plugin`);
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

test("the handoff brief says a compliance refusal is terminal, not a judgement about proceeding", () => {
  const source = promptTemplate(readFileSync(join(SKILL, "task.js"), "utf8"), "handoffPrompt");
  const handoff = source.replace(/\s+/g, " ");
  for (const phrase of [
    "DECIDES HOW TO REWORD A HIT, NEVER WHETHER TO PROCEED PAST IT",
    "Exit 2 is TERMINAL",
    "never in a label applied by hand",
  ]) {
    assert.ok(
      handoff.includes(phrase),
      `the handoff brief invites a lane holding a hit on its own subject matter to read the refusal as ` +
        `advisory and label by hand, which is how a pull request carried the label with no verdict behind ` +
        `it on 2026-09-12. Missing: ${phrase}`,
    );
  }
});

function complianceRefusal(): string {
  const source = readFileSync(join(SKILL, "lane-handoff.sh"), "utf8");
  const start = source.indexOf('echo "Fix the PR body or the commit message');
  const end = source.indexOf("return 2", start);
  assert.ok(start > 0 && end > start, "the compliance refusal block moved; this guard no longer reads it");
  return [...source.slice(start, end).matchAll(/^\s*echo "(.*)"$/gm)]
    .map((m) => m[1])
    .join(" ")
    .replace(/\s+/g, " ");
}

test("the handoff brief tells a lane the label token has no exemption and names the rewrite", () => {
  const source = promptTemplate(readFileSync(join(SKILL, "task.js"), "utf8"), "handoffPrompt");
  const handoff = source.replace(/\s+/g, " ");
  for (const phrase of [
    "NO SUBJECT-MATTER EXEMPTION AND NO COMPLIANT SPELLING",
    "name the label in words rather than writing the token",
  ]) {
    assert.ok(
      handoff.includes(phrase),
      `a lane holding a leakage hit on its own subject matter needs the brief to say both that there is ` +
        `no spelling that passes and what to write instead; without the second half 'do not proceed' is ` +
        `an instruction with nowhere to go. Missing: ${phrase}`,
    );
  }
});

test("neither the brief nor the refusal offers a typeset spelling or claims a check that is not there", () => {
  const handoff = promptTemplate(readFileSync(join(SKILL, "task.js"), "utf8"), "handoffPrompt").replace(
    /\s+/g,
    " ",
  );
  const refusal = complianceRefusal();

  assert.ok(refusal.includes("NO SUCH EXEMPTION AND NO COMPLIANT SPELLING"), refusal);
  assert.ok(refusal.includes("naming the label in words"), refusal);

  for (const [surface, text] of [
    ["the handoff brief", handoff],
    ["the compliance refusal", refusal],
  ] as const) {
    for (const claim of [/code span/i, /neutralis/i, /raw text/i]) {
      assert.doesNotMatch(
        text,
        claim,
        `${surface} describes a carve-out for the label token that the compliance check does not ` +
          `implement - it greps the literal token and nothing subtracts a spelling from it first. A ` +
          `surface that promises one teaches the next lane a spelling that is refused, or worse, one ` +
          `that passes. Offending pattern: ${claim}`,
      );
    }
  }
});

test("the brief tells a lane to leave the three plugin version files alone", () => {
  const fix = promptTemplate(readFileSync(join(SKILL, "task.js"), "utf8"), "fixPrompt");
  for (const path of [
    ".claude-plugin/marketplace.json",
    "plugins/devloop/.claude-plugin/plugin.json",
    "plugins/devloop/skills/devloop/CHANGELOG.md",
  ]) {
    assert.ok(
      fix.includes(path),
      `the brief does not name ${path}, so a lane still reads master and picks a number every other ` +
        "lane in the pass picked - the first to land moves master past the rest, and the rest are " +
        "refused for a reason that has nothing to do with their content",
    );
  }
});

test("the changelog heading the brief asks a lane for is the one the lander looks for", () => {
  const fix = promptTemplate(readFileSync(join(SKILL, "task.js"), "utf8"), "fixPrompt");
  const script = readFileSync(join(SKILL, "assign-plugin-version.sh"), "utf8");
  const declared = /^HEADING='(.+)'$/m.exec(script);
  assert.ok(declared, "assign-plugin-version.sh declares no HEADING - update this test rather than deleting it");
  assert.ok(
    fix.includes(declared[1] as string),
    `the brief asks for a section the lander does not read. The entry would be silently replaced by ` +
      `the pull request title, and nothing would fail: the lander looks for '${declared[1]}'`,
  );
});

const HANDOFF_REPOS = {
  site: { path: "cli", slug: "404sl/pitwall", role: "node", test: "npm test", lint: "npm run lint" },
  integration: { path: "schema", slug: "404sl/pitwall-schema", role: "node", test: "npm test", lint: "npm run lint" },
  docs: { path: "site", slug: "404sl/pitwall-site", role: "node", test: "npm test", lint: "npm run lint" },
};

async function handoffBrief(repo: string): Promise<string> {
  const { calls, done } = runScript(
    "task.js",
    { id: "zz-aaa1", slot: 3, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: HANDOFF_REPOS },
    (call, n) => {
      if (n === 1) {
        return { eligible: true, repo, title: "a guessed slug", priority: 1, ui: false, reason: "", ticket: "the ticket body" };
      }
      if (call.label.startsWith("fix:")) {
        return { status: "pushed", summary: "fixed", prNumber: 47, prUrl: "https://example.test/pr/47" };
      }
      if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
      if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 47, notes: "" };
      return { lane: "released", slot: "released" };
    },
  );
  await done;
  const handoff = calls.find((c) => c.label.startsWith("handoff:"));
  assert.ok(handoff, `no handoff step ran for ${repo}. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return handoff.prompt;
}

test("the handoff brief hands the lane its repository's slug rather than a placeholder", async () => {
  for (const [repo, { slug }] of Object.entries(HANDOFF_REPOS)) {
    const brief = await handoffBrief(repo);
    const guesses = brief.split("\n").filter((line) => line.includes("<owner/name>"));
    assert.deepEqual(
      guesses,
      [],
      `the brief for ${repo} leaves the slug for the lane to guess, and a guess that names a real ` +
        "pull request in another repository is how the lane-verified label reaches one. The value " +
        `is in the config the repo path already comes from:\n${guesses.join("\n")}`,
    );
    assert.match(
      brief,
      new RegExp(`--slug ${slug}\\s+--pr `),
      `the handoff command in the brief for ${repo} does not pass ${slug}, so the script is told ` +
        "to check a pull request in a repository the ticket never touched",
    );
  }
});

test("the handoff brief says a refusal is never answered by labelling by hand", async () => {
  const brief = await handoffBrief("site");
  assert.ok(
    brief.includes("A REFUSAL IS NEVER WORKED AROUND BY LABELLING BY HAND"),
    "the brief offers no reading of a refusal other than the lane's own judgement. Two lanes have " +
      "met a correct refusal and one labelled its pull request by hand, which skips the compliance " +
      "gate that is the only reason the script is run at all.",
  );
  assert.ok(
    brief.includes("file a ticket quoting the exact command and exit code"),
    "the brief does not say what to do with a suspected defect in the script, so the lane is left " +
      "choosing between believing a refusal it thinks is wrong and bypassing it",
  );
});

const NOTE_WRITERS = ["task.js", "land.js", "land-train.js", "rework.js"];

test("no brief tells a run to write a tracker note with a raw append", () => {
  for (const file of NOTE_WRITERS) {
    const source = readFileSync(join(SKILL, file), "utf8");
    const raw = source
      .split("\n")
      .map((line, at) => ({ line, at: at + 1 }))
      .filter(({ line }) => line.includes("--append-notes"))
      .filter(({ line }) => !line.includes("bd-note.sh"));
    assert.deepEqual(
      raw.map(({ line, at }) => `${file}:${at}:${line.trim()}`),
      [],
      "a raw append is an unserialised read-modify-write on one text field: two overlapping " +
        "writers both read the old notes, both append, and the second wins - exit 0, no trace. " +
        "It is also the only path that produces an unstamped note, and passing the text as a " +
        "shell argument has already had a note truncated at a backtick. bd-note.sh takes the " +
        "lock, reads the write back and stamps it; the briefs have to send a run through it.",
    );
  }
});

const WRITES_NOTES = ["task.js", "land.js", "land-train.js"];

test("every brief that asks for a tracker note names the script and the writer", () => {
  for (const file of WRITES_NOTES) {
    const source = readFileSync(join(SKILL, file), "utf8");
    assert.ok(
      source.includes("${SKILL_DIR}/bd-note.sh"),
      `${file} no longer names bd-note.sh by the skillDir it is handed, so a run has no path to ` +
        "the script and falls back to the raw append this guard exists to keep out",
    );
    assert.ok(
      source.includes("PITWALL_SESSION="),
      `${file} invokes bd-note.sh without PITWALL_SESSION, so the stamp names whatever $USER the ` +
        "run happens to carry rather than the session that wrote the note",
    );
    assert.ok(
      source.includes("--note-file"),
      `${file} passes the note as an argument rather than from a file, so a backtick or a dollar-` +
        "paren in it is evaluated by the shell before bd sees it and the note is stored truncated",
    );
  }
});

test("the brief that parks an issue renders the note command against the issue it parks", async () => {
  const { calls, done } = runScript(
    "task.js",
    { id: "zz-aaa2", slot: 1, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: HANDOFF_REPOS },
    (call, n) => {
      if (n === 1) {
        return { eligible: false, repo: "site", title: "needs a person", priority: 2, ui: false, reason: "a decision", ticket: "" };
      }
      return { verification: "zz-aaa2 [BUG] OPEN needs-decision", notes: "" };
    },
  );
  await done;
  const handover = calls.find((c) => c.label.startsWith("handover:"));
  assert.ok(handover, `no handover step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  assert.ok(
    handover.prompt.includes("/skill/bd-note.sh zz-aaa2 --note-file "),
    "the park brief does not resolve bd-note.sh against the skillDir it was handed and name the " +
      `issue, so the run has nothing to invoke:\n${handover.prompt}`,
  );
});
