import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
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
  const opened = source.indexOf("`", start);
  assert.notEqual(opened, -1, `the standing shell block in ${file} never opens its template literal`);
  const body = opened + 1;
  const end = source.indexOf("`\n", body);
  assert.notEqual(end, -1, `the standing shell block in ${file} has no end`);
  return source.slice(body, end);
}

test("the standing shell block carries no backticks in any script that hands it out", () => {
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "refine.js"]) {
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
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "refine.js", "land-train.sh", "land-one.sh"]) {
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
  for (const file of ["task.js", "land.js", "rework.js", "land-train.js", "refine.js", "config.sh", "lock-check.sh", "lane-running.sh", "git-guard.sh"]) {
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
      promptTemplate(source, name).includes("${LAW("),
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
    sentence < handoff.indexOf("${LAW("),
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
  const start = source.indexOf('echo "non-compliant: ${_slug}#${_pr} was NOT labelled."');
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

test("the fix brief puts the commit-message check before the push, not after it", () => {
  const fix = promptTemplate(readFileSync(join(SKILL, "task.js"), "utf8"), "fixPrompt");
  const check = fix.indexOf("--pre-push");
  const open = fix.indexOf("gh pr create");

  assert.ok(
    check > 0,
    "the brief never tells a lane to read its own commit messages back while the branch is still " +
      "local. A hit found after the push needs a force-push to clear, which a run may not do, so " +
      "the pull request is green, correct and waiting on a person - three were at once.",
  );
  assert.ok(
    check < open,
    "the brief asks for the commit-message check after the pull request is opened, which is the " +
      "one moment it cannot be acted on. A check that runs after the push is a check nobody can use.",
  );
});

test("the compliance refusal says which half of a hit a run cannot fix", () => {
  const refusal = complianceRefusal();

  assert.ok(
    refusal.includes("NEEDS A PERSON"),
    `the refusal names a commit-message hit and a body hit in one breath, so a run reads both as ` +
      `fixable and retries the half that never clears. Offered: ${refusal}`,
  );
  assert.ok(
    refusal.includes("--pre-push"),
    `the refusal does not say where the hit was catchable, so the next branch arrives here the same ` +
      `way. Offered: ${refusal}`,
  );
});

test("the rules never call a commit-message hit unfixable without saying it is pushed", () => {
  const rules = bodyOfRulesTemplate(readFileSync(join(SKILL, "task.js"), "utf8"));
  const verdicts = rules.split("\n").filter((line) => line.includes("NO FIX AVAILABLE TO YOU"));

  assert.ok(
    verdicts.length > 0,
    "the brief no longer says that a pushed commit message cannot be reworded by a run, which is " +
      "the fact that makes the pre-push check worth running at all",
  );
  for (const line of verdicts) {
    assert.match(
      line,
      /PUSHED/,
      "the unfixable verdict leads unqualified, so a run that skims the rule returns 'blocked' on " +
        "a hit found while the branch is still local and an amend is free - the exact outcome the " +
        `pre-push check exists to prevent: ${line}`,
    );
  }
});

test("the rework briefs read the commit messages back before every push, and never force one", () => {
  const source = readFileSync(join(SKILL, "rework.js"), "utf8");
  const pushes = [...source.matchAll(/\bgit push\b/g)].map((m) => m.index ?? -1);

  assert.ok(
    pushes.length >= 2,
    "rework.js no longer pushes where this test expects it to - update the test rather than " +
      "deleting it",
  );
  assert.equal(
    source.includes("force-with-lease"),
    false,
    "rework.js renders a lease. A rework rewrites nothing - it merges master in and pushes the " +
      "fast-forward that leaves - and a force-push, leased or not, is what the session refuses, " +
      "so every rework that asks for one ends on a person's board with a one-line command.",
  );
  assert.equal(source.includes("--rebased"), false, "rework.js tells the pre-push check the range was rebased, and it is not");

  let from = 0;
  for (const at of pushes) {
    const segment = source.slice(from, at);
    assert.ok(
      segment.includes("--pre-push --branch"),
      "a push in rework.js is reached with nothing having read the commit messages first, or with " +
        "a check that cannot tell which commits are published: the worktree is detached, so the " +
        "check needs --branch to ask the remote. The commit the step writes on top is the one " +
        "nothing has graded - a hit found after the push is a pull request that is green, " +
        "correct and waiting on a person.",
    );
    from = at;
  }
});

test("the briefs name the answer the pre-push check gives a branch it cannot fast-forward", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  const briefs = [promptTemplate(source, "fixPrompt"), bodyOfRulesTemplate(source)];

  for (const brief of briefs) {
    assert.ok(
      /Exit 10/.test(brief),
      "the brief reads the pre-push check as answering only clean or hit. Its third answer is a " +
        "branch the remote holds at a head the lane's HEAD does not contain - what a rebase " +
        "leaves - where no plain push exists at all. A lane told only about 0 and 2 reads that " +
        "refusal as a defect in the script and pushes anyway.",
    );
  }

  const fix = promptTemplate(source, "fixPrompt");
  const third = fix.slice(fix.indexOf("Exit 10"), fix.indexOf("Exit 10") + 500);
  assert.match(
    third,
    /'blocked'/,
    `the brief names the exit and not the outcome, so a lane that meets it has nothing to return. ` +
      `There is no remedy for it to try: the push itself is what cannot be made. Offered: ${third}`,
  );
});

const NOTE_WRITERS = ["task.js", "land.js", "land-train.js", "rework.js", "refine.js"];

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

const WRITES_NOTES = ["task.js", "land.js", "land-train.js", "refine.js"];

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

function triageTemplate(source: string): string {
  const open = "const triage = await agent(`";
  const start = source.indexOf(open);
  assert.notEqual(start, -1, "the triage brief moved - update this test rather than deleting it");
  const end = source.indexOf("`,\n  { label: `triage:", start);
  assert.notEqual(end, -1, "could not find the end of the triage brief");
  return source.slice(start + open.length, end);
}

async function triageBrief(): Promise<string> {
  const { calls, done } = runScript(
    "task.js",
    { id: "zz-aaa3", slot: 1, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: HANDOFF_REPOS },
    (call, n) => {
      if (n === 1) {
        return { eligible: false, repo: "site", title: "needs a person", priority: 2, ui: false, reason: "a decision", ticket: "" };
      }
      return { verification: "zz-aaa3 [BUG] OPEN needs-decision", notes: "" };
    },
  );
  await done;
  const triage = calls.find((c) => c.label.startsWith("triage:"));
  assert.ok(triage, `no triage step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
  return triage.prompt;
}

test("the triage brief carries no backticks of its own", () => {
  const brief = triageTemplate(readFileSync(join(SKILL, "task.js"), "utf8"));
  const found = brief.split("\n").filter((line) => line.includes("`"));
  assert.deepEqual(
    found,
    [],
    `a backtick inside the brief closes its template literal early. Use 'single quotes':\n${found.join("\n")}`,
  );
});

const CHECKS_A_CHECKOUT = /^\s+(git|ls)\b/;

test("the triage brief verifies files and ancestry against origin/master, never the checkout's HEAD", async () => {
  const brief = await triageBrief();
  const commands = brief.split("\n").filter((line) => CHECKS_A_CHECKOUT.test(line));

  assert.ok(
    commands.some((line) => line.includes("ls-tree --name-only origin/master")),
    "the brief no longer tells triage how to ask origin/master whether a path exists, so a run " +
      "improvises against the root checkout - which nobody fast-forwards in a workflow where every " +
      "lane branches from origin/master and lands from a worktree",
  );
  assert.ok(
    commands.some((line) => line.includes("merge-base --is-ancestor <sha> origin/master")),
    "the brief no longer tells triage how to check a commit has landed, so a run asks HEAD of the " +
      "root checkout and reports a merged, deployed commit as not an ancestor",
  );
  assert.ok(
    commands.some((line) => line.includes("fetch origin --quiet")),
    "the brief asks origin/master without fetching first, and a remote-tracking ref nobody has " +
      "fetched is stale one level down from the checkout it sits in",
  );

  const stale = commands.filter((line) => /\bHEAD\b|\bls-files\b|^\s+ls\s/.test(line));
  assert.deepEqual(
    stale,
    [],
    "a command in the triage brief reads the root checkout's working tree or HEAD. On 2026-09-12 " +
      "that checkout was 35 merges behind origin/master, and triage bounced an issue over a file " +
      "and a commit that were both on master, naming prerequisite branches already merged and " +
      `deployed:\n${stale.join("\n")}`,
  );
});

const TRUNK_REPOS = {
  site: { path: "cli", slug: "acme/site", role: "node", test: "npm test", lint: "npm run lint", defaultBranch: "trunk" },
  integration: { path: "schema", slug: "acme/schema", role: "node", test: "npm test", defaultBranch: "trunk" },
  docs: { path: "site", slug: "acme/docs", role: "script", test: "ruby script/check.rb", defaultBranch: "trunk" },
};

type Briefs = { triage: string; fix: string; review: string; handoff: string };

async function briefsFor(repos: unknown, repo: string): Promise<Briefs> {
  const { calls, done } = runScript(
    "task.js",
    { id: "zz-aaa4", slot: 2, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos },
    (call, n) => {
      if (n === 1) {
        return { eligible: true, repo, title: "lands on another branch", priority: 1, ui: false, reason: "", ticket: "the ticket body" };
      }
      if (call.label.startsWith("fix:")) {
        return { status: "pushed", summary: "fixed", prNumber: 48, prUrl: "https://example.test/pr/48" };
      }
      if (call.label.startsWith("review:")) return { approved: true, notes: "good" };
      if (call.label.startsWith("handoff:")) return { status: "verified", verified: true, prNumber: 48, notes: "" };
      return { lane: "released", slot: "released" };
    },
  );
  await done;
  const find = (step: string): string => {
    const call = calls.find((c) => c.label.startsWith(`${step}:`));
    assert.ok(call, `no ${step} step ran for ${repo}. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
    return call.prompt;
  };
  return { triage: find("triage"), fix: find("fix"), review: find("review"), handoff: find("handoff") };
}

test("every brief names the configured default branch and never origin/master when the repo lands elsewhere", async () => {
  const briefs = await briefsFor(TRUNK_REPOS, "site");
  for (const step of ["triage", "fix", "review", "handoff"] as const) {
    const brief = briefs[step];
    const stale = brief.split("\n").filter((line) => line.includes("origin/master"));
    assert.deepEqual(
      stale,
      [],
      `the ${step} brief still says origin/master to a lane whose repository lands on trunk. A lane ` +
        "does what its brief says whatever the workspace config says, so the interpolation has to " +
        `reach the prompt text, not only the code:\n${stale.join("\n")}`,
    );
    assert.ok(brief.includes("origin/trunk"), `the ${step} brief never names origin/trunk, so the base was dropped rather than interpolated`);
  }

  const fix = briefs.fix;
  assert.ok(fix.includes("git worktree add /tmp/pw-worktrees/zz-aaa4 -b devloop/zz-aaa4 origin/trunk"), "the worktree is not cut from the configured branch");
  assert.ok(fix.includes("git log origin/trunk..HEAD"), "an inherited branch is not read against the configured base");
  assert.ok(fix.includes("git diff origin/trunk...HEAD --stat"), "an inherited branch is not diffed against the configured base");
  assert.ok(
    fix.includes('git -c user.name="$(git log -1 --format=%an origin/trunk)" -c user.email="$(git log -1 --format=%ae origin/trunk)"'),
    "the commit identity is read from a branch this repository does not land on",
  );
  assert.ok(fix.includes("--pre-push --base trunk"), "the commit-message check is not told which base the range starts at, so it defaults to master");
  assert.ok(fix.includes("gh pr create --base trunk"), "the pull request is opened with no --base, which is the case the report called dangerous");
  assert.ok(fix.includes("open the pull request against\ntrunk"), "the brief still tells the lane which branch to target in prose that names the wrong one");
  assert.ok(
    fix.includes("git-guard.sh --dir=<absolute worktree path> --branch=<your branch> --default=trunk -- git <command>"),
    "rule 3 of the brief does not pass the configured default to the guard, so a lane whose repository " +
      "lands on trunk is told to guard its pushes with a script that refuses only master and main",
  );

  assert.ok(briefs.review.includes("rtk git diff origin/trunk...HEAD"), "the reviewer reads the diff against a branch the change was not cut from");
  assert.ok(briefs.handoff.includes("git log origin/trunk..origin/devloop/zz-aaa4 --format=%B"), "the handoff reads commit messages over the wrong range");

  const docs = await briefsFor(TRUNK_REPOS, "docs");
  assert.ok(docs.fix.includes("-b devloop/zz-aaa4 origin/trunk"), "the script-role worktree is still cut from origin/master");
  assert.ok(docs.fix.includes("--pre-push --base trunk"), "the script-role commit check is not told its base");
  assert.ok(docs.fix.includes("gh pr create --base trunk"), "the script-role pull request is opened with no --base");
  assert.ok(docs.fix.includes("--branch=<your branch> --default=trunk -- git <command>"), "the script-role guard command is not handed its base");
});

test("the guard command in a brief for a repository with no configured default names master", async () => {
  const fix = (await briefsFor(HANDOFF_REPOS, "site")).fix;
  assert.ok(
    fix.includes("git-guard.sh --dir=<absolute worktree path> --branch=<your branch> --default=master -- git <command>"),
    "absent a configured default the guard command has to name master, which is what absent means in the config",
  );
});

test("the triage brief asks the configured branch, and names each checkout's own when they differ", async () => {
  const shared = (await briefsFor(TRUNK_REPOS, "site")).triage;
  const commands = shared.split("\n").filter((line) => CHECKS_A_CHECKOUT.test(line));
  assert.ok(commands.some((line) => line.includes("ls-tree --name-only origin/trunk")), "triage is told to look for a path on a branch nothing lands on");
  assert.ok(commands.some((line) => line.includes("merge-base --is-ancestor <sha> origin/trunk")), "triage is told to check ancestry against a branch nothing lands on");
  assert.deepEqual(
    commands.filter((line) => line.includes("origin/master")),
    [],
    "a command in the triage brief still asks origin/master in a workspace where every repository lands on trunk",
  );

  const mixed = (await briefsFor({ ...TRUNK_REPOS, docs: { ...TRUNK_REPOS.docs, defaultBranch: undefined } }, "site")).triage;
  assert.ok(mixed.includes("site  ->  /root/cli  (acme/site)  lands on origin/trunk"), "the repo table does not say which branch site lands on");
  assert.ok(mixed.includes("docs  ->  /root/site  (acme/docs)  lands on origin/master"), "a repository with no defaultBranch configured no longer reads as master in the table");
  assert.ok(
    mixed.includes("ls-tree --name-only origin/<default branch> '<the path it names>'"),
    "with two default branches in one workspace the routing command names one of them as if it were both",
  );
  assert.ok(!mixed.includes("ls-tree --name-only origin/trunk '<the path it names>'"), "the routing command picked one repository's branch for every checkout");
});

const OWNERS_TEST = /would the owner's answer differ from any competent engineer's\?/i;

test("the briefs that stop pick the park label with the owner's-answer test, and name all three labels", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  for (const name of ["fixPrompt", "workspacePrompt"]) {
    const brief = promptTemplate(source, name);
    const from = brief.indexOf("STOP AND ASK");
    assert.notEqual(from, -1, `${name} no longer has a STOP AND ASK block`);
    const until = brief.indexOf("needs_feedback", from);
    assert.notEqual(until, -1, `${name}'s STOP AND ASK block never returns needs_feedback`);
    const stop = brief.slice(from, brief.indexOf("\n", until));
    const lines = stop.split("\n").filter((line) => OWNERS_TEST.test(line));
    assert.ok(
      lines.length > 0,
      `${name} does not carry the test verbatim on one line - would the owner's answer differ from any ` +
        "competent engineer's? A run with no test for which label to write reaches for needs-decision " +
        "every time, and three settled engineering questions went onto the owner's board in one day that way",
    );
    for (const label of ["needs-decision", "needs-call", "needs-access"]) {
      assert.ok(stop.includes(label), `${name} tells a run how to stop without naming ${label}`);
    }
    const labelLine = stop.split("\n").find((line) => line.includes("bd label add ${task.id}"));
    assert.ok(labelLine, `${name} never tells a run the label command`);
    assert.ok(labelLine.includes("needs-call"), `${name}'s label command offers no needs-call:\n${labelLine}`);
    assert.ok(
      labelLine.includes("needs-access if it needs") || labelLine.includes("needs-access>"),
      `${name}'s label command changed what needs-access means:\n${labelLine}`,
    );
    const ticks = stop.split("\n").filter((line) => line.includes("`"));
    assert.deepEqual(ticks, [], `a backtick inside ${name} closes its template literal early:\n${ticks.join("\n")}`);
  }
});

test("the stopping section of the skill carries the same test and both labels", () => {
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const start = skill.indexOf("## Where it stops and asks");
  assert.notEqual(start, -1, "the stopping section moved - update this test rather than deleting it");
  const end = skill.indexOf("\n## ", start + 1);
  const section = skill.slice(start, end === -1 ? undefined : end);
  assert.match(section, OWNERS_TEST, "the skill's stopping section does not carry the test the brief carries");
  for (const label of ["needs-decision", "needs-call", "needs-access"]) {
    assert.ok(section.includes(`\`${label}\``), `the stopping section no longer names ${label}`);
  }
});

test("a park verified as open with needs-call is a park, not a failure, and the handover offers the label", async () => {
  const seen: string[] = [];
  for (const label of ["needs-call", "needs-decision"]) {
    const { calls, logs, done } = runScript(
      "task.js",
      { id: "zz-aaa5", slot: 1, root: "/root", skillDir: "/skill", lockPrefix: "pw", repos: HANDOFF_REPOS },
      (_call, n) => {
        if (n === 1) {
          return { eligible: false, repo: "site", title: "needs a call", priority: 2, ui: false, reason: "a call", ticket: "" };
        }
        return { verification: `zz-aaa5 [BUG] OPEN ${label}`, notes: "" };
      },
    );
    await done;
    seen.push(...logs);
    const handover = calls.find((c) => c.label.startsWith("handover:"));
    assert.ok(handover, `no handover step ran. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`);
    const labelLine = handover.prompt.split("\n").find((line) => line.includes("bd label add zz-aaa5"));
    assert.ok(labelLine, `the handover never tells the run the label command:\n${handover.prompt}`);
    assert.ok(
      labelLine.includes("needs-call"),
      `the handover verifies a needs-call park but its label command cannot produce one:\n${labelLine}`,
    );
    assert.ok(
      handover.prompt.split("\n").some((line) => OWNERS_TEST.test(line)),
      "the handover offers needs-call without the one test that picks it",
    );
    assert.ok(
      !logs.some((line) => line.includes("PARK FAILED")),
      `an issue reopened with ${label} was reported as not parked, so a person is told to park by hand ` +
        `what is already parked:\n${logs.join("\n")}`,
    );
  }
  assert.ok(seen.length > 0, "the handover path logged nothing at all - the check may no longer run");
});
