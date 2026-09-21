import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { INTAKE_DIR, INTAKE_LABEL } from "../src/intake.ts";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const ID = "zz-req1";
const ACTOR = "zz-devloop";
const RAW = "PROBLEMS is unreadable, I have no idea what to do with these rows";

const ARGS = {
  id: ID,
  slot: 2,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  idPrefix: "zz",
  actor: ACTOR,
  repos: {
    site: { path: "cli", slug: "acme/site", test: "npm test" },
    workspace: { path: ".", role: "workspace" },
  },
};

type Refined = Record<string, unknown>;

function reading(overrides: Refined): Refined {
  return {
    outcome: "refined",
    repo: "site",
    raw: RAW,
    assignee: "zz-planning-session",
    attachments: { read: ["board.png"], unreadable: [] },
    measured: "src/ui/problems.tsx:41 renders one row per error, 74 rows for 3 causes",
    specification: "Collapse the PROBLEMS rows by cause.\n\nTRAP: do not hide rows.\n\nACCEPTANCE: 3 rows for the fixture.",
    notes: "",
    ...overrides,
  };
}

function recorded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "recorded",
    noteLanded: true,
    labels: [],
    assignee: ACTOR,
    issueStatus: "open",
    descriptionUnchanged: true,
    notes: "",
    ...overrides,
  };
}

const RELEASED = { lane: "already_gone", slot: "released", notes: "" };

async function run(
  refined: Refined | null,
  record: Record<string, unknown> | (() => never) = recorded(),
  args: Record<string, unknown> = ARGS,
): Promise<{ calls: Call[]; result: Record<string, unknown> }> {
  const { calls, done } = runScript("refine.js", args, (call, n) => {
    if (n === 1) return refined;
    if (call.label.startsWith("record:")) return typeof record === "function" ? record() : record;
    return RELEASED;
  });
  const result = await done;
  return { calls, result };
}

function step(calls: Call[], prefix: string): Call | undefined {
  return calls.find((c) => c.label.startsWith(prefix));
}

function commandLines(prompt: string): string[] {
  return prompt.split("\n").filter((line) => /^ {2}\S/.test(line) && /\bbd\b/.test(line));
}

const REWRITES_THE_REQUEST = /(^|\s)(-d|--description|--body-file|--stdin|--title|--notes|--metadata|--set-metadata)(\s|$)/;

test("the refine brief reads the request as recorded, its files, and the standard, and writes nothing", async () => {
  const { calls } = await run(reading({}));
  const refine = step(calls, "refine:");
  assert.ok(refine, `no refine step ran: ${calls.map((c) => c.label).join(", ")}`);
  const brief = refine.prompt;
  assert.ok(brief.includes(`'${INTAKE_LABEL}'`), "the brief does not name the label the console puts on a recorded request");
  assert.ok(brief.includes(`/root/${INTAKE_DIR}/${ID}/`), "the brief does not name the directory the console drops files into");
  assert.ok(brief.includes("/skill/WRITING-TICKETS.md"), "the brief does not point the refiner at the standard");
  assert.ok(brief.includes(`bd show ${ID} --json`), "the brief does not read the issue as data");
  assert.match(brief, /origin\/master/);
  assert.match(brief, /site {2}-> {2}\/root\/cli/, "the brief does not table the configured repositories with their checkouts");
  assert.equal(commandLines(brief).filter((line) => /\bbd (update|close|create|label)\b/.test(line)).length, 0, `the refine brief tells the refiner to write:\n${commandLines(brief).join("\n")}`);
  assert.equal(commandLines(brief).filter((line) => line.includes("bd-note.sh")).length, 0, "the refine brief hands the refiner the note writer; the record step owns every write");
});

test("a refined request is appended beside the raw text with its repository first, and routed to the devloop", async () => {
  const { calls, result } = await run(reading({ attachments: { read: ["board.png"], unreadable: ["notes.pdf - not a format this tool opens"] } }));
  const record = step(calls, "record:");
  assert.ok(record, `no record step ran: ${calls.map((c) => c.label).join(", ")}`);
  const brief = record.prompt;
  assert.match(brief, /^Repo: site \(\/root\/cli\)$/m, "the specification does not lead with the repository and its checkout");
  assert.match(brief, /^Collapse the PROBLEMS rows by cause\.$/m);
  assert.ok(brief.includes("board.png"), "a file the refiner read is not named");
  assert.ok(brief.includes("notes.pdf - not a format this tool opens"), "a file the refiner could not read is not named");
  assert.ok(brief.includes(RAW), "the record step is not shown the raw request it must leave alone");
  const note = commandLines(brief).find((line) => line.includes("bd-note.sh"));
  assert.ok(note, "the note is not written through bd-note.sh");
  assert.match(note, new RegExp(`BEADS_ACTOR=${ACTOR} PITWALL_SESSION=refine-${ID} bash /skill/bd-note\\.sh ${ID} --note-file /tmp/pw-scratch/${ID}/refine-note\\.txt`));
  const route = commandLines(brief).find((line) => /\bbd --actor \S+ update\b/.test(line));
  assert.ok(route, "no routing command");
  assert.equal(route.trim(), `cd /root && bd --actor ${ACTOR} update ${ID} --remove-label ${INTAKE_LABEL} -a ${ACTOR} -s open`);
  assert.equal(result["outcome"], "refined");
  assert.equal(result["repo"], "site");
  assert.equal(result["rawUnchanged"], true);
  assert.equal(result["slot"], "released");
});

test("an underdetermined request is parked with one question, keeps its label, and stays in the planning session's queue", async () => {
  const { calls, result } = await run(
    reading({
      outcome: "needs_answer",
      repo: "unknown",
      understood: "The board renders 74 rows because every error is its own row.",
      question: "Should PROBLEMS group rows by cause, or by repository?",
    }),
    recorded({ labels: ["needs-decision", INTAKE_LABEL], assignee: "zz-planning-session" }),
  );
  const record = step(calls, "record:");
  assert.ok(record, `no record step ran: ${calls.map((c) => c.label).join(", ")}`);
  const brief = record.prompt;
  assert.match(brief, /^QUESTION: Should PROBLEMS group rows by cause, or by repository\?$/m);
  assert.ok(brief.includes("The board renders 74 rows"), "what was understood is not carried to the person");
  const route = commandLines(brief).find((line) => /\bbd --actor \S+ update\b/.test(line));
  assert.ok(route, "no parking command");
  assert.equal(route.trim(), `cd /root && bd --actor ${ACTOR} update ${ID} --add-label needs-decision -s open`);
  assert.equal(brief.includes(`--remove-label ${INTAKE_LABEL}`), false, "a parked request loses its label and is never refined again once answered");
  assert.equal(brief.includes(`-a ${ACTOR}`), false, "a question is routed into the devloop's queue");
  assert.equal(result["outcome"], "needs_answer");
  assert.equal(result["question"], "Should PROBLEMS group rows by cause, or by repository?");
});

test("a request that is not work is closed with the reason and the evidence", async () => {
  const { calls, result } = await run(
    reading({ outcome: "not_work", repo: "unknown", why: "duplicate", duplicateOf: "zz-old9", reason: "zz-old9 asks for the same grouping and is open.", measured: "bd search grouping: zz-old9" }),
    recorded({ issueStatus: "closed", assignee: "zz-planning-session", labels: [INTAKE_LABEL] }),
  );
  const record = step(calls, "record:");
  assert.ok(record, `no record step ran: ${calls.map((c) => c.label).join(", ")}`);
  const brief = record.prompt;
  assert.match(brief, /^NOT WORK - duplicate of zz-old9\. zz-old9 asks for the same grouping and is open\.$/m);
  const close = commandLines(brief).find((line) => /\bbd --actor \S+ close\b/.test(line));
  assert.ok(close, "no close command");
  assert.equal(close.trim(), `cd /root && bd --actor ${ACTOR} close ${ID} --reason-file /tmp/pw-scratch/${ID}/close-reason.txt`);
  assert.equal(result["outcome"], "not_work");
  assert.equal(result["why"], "duplicate");
});

test("no command in any brief rewrites the request, its title or its metadata, and every tracker write carries the actor", async () => {
  const outcomes: Refined[] = [
    reading({}),
    reading({ outcome: "needs_answer", repo: "unknown", understood: "u", question: "q?" }),
    reading({ outcome: "not_work", repo: "unknown", why: "done", reason: "shipped in abc123" }),
  ];
  for (const refined of outcomes) {
    const { calls } = await run(refined, recorded({ issueStatus: refined["outcome"] === "not_work" ? "closed" : "open", labels: refined["outcome"] === "needs_answer" ? ["needs-decision", INTAKE_LABEL] : [] }));
    for (const call of calls) {
      for (const line of commandLines(call.prompt)) {
        assert.doesNotMatch(line, REWRITES_THE_REQUEST, `${call.label} tells a run to rewrite the request:\n${line}`);
        if (/\bbd (update|close|create|label)\b/.test(line)) {
          assert.match(line, /\bbd --actor \S+ (update|close|create|label)\b/, `${call.label} writes to the tracker without an actor:\n${line}`);
        }
        if (line.includes("bd-note.sh")) {
          assert.match(line, /\bBEADS_ACTOR=\S+ /, `${call.label} appends a note without an actor:\n${line}`);
        }
      }
    }
  }
});

test("a specification that names no configured repository is refused before anything is written", async () => {
  const { calls, result } = await run(reading({ repo: "unknown" }));
  assert.equal(step(calls, "record:"), undefined, "the record step ran for a specification a lane cannot start from");
  assert.equal(result["outcome"], "error");
  assert.equal(result["releaseClaim"], true);
  assert.match(String(result["notes"]), /repository named/);
  assert.match(String(result["notes"]), /74 rows/, "the measurement is lost with the refusal");
  assert.ok(step(calls, "release:"), "the slot was not given back");
});

test("a question that asks nothing is refused before anything is written", async () => {
  const { calls, result } = await run(reading({ outcome: "needs_answer", repo: "unknown", understood: "u", question: "  " }));
  assert.equal(step(calls, "record:"), undefined, "the record step parked an issue with no question on it");
  assert.equal(result["outcome"], "error");
  assert.equal(result["releaseClaim"], true);
  assert.match(String(result["notes"]), /asked no question/);
});

test("a description that changed under the record step is reported, never as success", async () => {
  const { result } = await run(reading({}), recorded({ descriptionUnchanged: false }));
  assert.equal(result["outcome"], "error");
  assert.equal(result["rawUnchanged"], false);
  assert.match(String(result["notes"]), /DESCRIPTION CHANGED/);
});

test("a record step whose read-back does not match the route it was given is an error", async () => {
  const { result } = await run(reading({}), recorded({ labels: [INTAKE_LABEL] }));
  assert.equal(result["outcome"], "error");
  assert.match(String(result["notes"]), new RegExp(`no ${INTAKE_LABEL} label, assignee ${ACTOR}, status open`));
});

test("the slot is given back when the record step dies", async () => {
  const { calls, done } = runScript("refine.js", ARGS, (call, n) => {
    if (n === 1) return reading({});
    if (call.label.startsWith("record:")) throw new Error("the record step died");
    return RELEASED;
  });
  await assert.rejects(done, /the record step died/);
  const release = step(calls, "release:");
  assert.ok(release, "no release step ran after the record step died");
  assert.match(release.prompt, /release-lane\.sh --lane \/tmp\/pw-lane-3\.lock --slot \/tmp\/pw-slots\/2 --owner 'zz-req1'/);
});

test("a dispatch with no actor, no slot or no repositories refuses before its first agent", async () => {
  for (const [missing, args] of [
    ["actor", { ...ARGS, actor: undefined }],
    ["slot", { ...ARGS, slot: undefined }],
    ["repos", { ...ARGS, repos: {} }],
    ["skillDir", { ...ARGS, skillDir: undefined }],
    ["root", { ...ARGS, root: undefined }],
  ] as const) {
    const { calls, done } = runScript("refine.js", args, () => RELEASED);
    const result = await done;
    assert.equal(calls.length, 0, `${missing} missing, yet an agent ran: ${calls.map((c) => c.label).join(", ")}`);
    assert.equal(result["outcome"], "error", `${missing} missing: ${JSON.stringify(result)}`);
    assert.equal(result["releaseClaim"], true, `${missing} missing, and the caller is not told to release the claim`);
  }
});

const BRIEFS = [
  "refinePrompt",
  "recordCommon",
  "recordRefinedPrompt",
  "recordQuestionPrompt",
  "recordClosePrompt",
  "releaseLanePrompt",
  "refinedNote",
  "questionNote",
  "closeReason",
  "marked",
];

function briefTemplate(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} moved or was renamed - update this test rather than deleting it`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return source.slice(start, end);
}

test("the briefs in refine.js carry no backticks of their own", () => {
  const source = readFileSync(join(SKILL, "refine.js"), "utf8");
  const offenders: string[] = [];
  for (const name of BRIEFS) {
    const lines = briefTemplate(source, name).split("\n");
    lines.forEach((line, at) => {
      if (!line.includes("`")) return;
      const opens = /^\s*return `/.test(line);
      const closes = /`$/.test(line);
      if (opens || closes) return;
      offenders.push(`${name}+${at}: ${line}`);
    });
  }
  const shell = source.indexOf("const SHELL_FIRST = `");
  assert.notEqual(shell, -1, "the standing shell block moved - update this test rather than deleting it");
  const shellEnd = source.indexOf("`\n", shell + "const SHELL_FIRST = `".length);
  const shellBody = source.slice(shell + "const SHELL_FIRST = `".length, shellEnd);
  if (shellBody.includes("`")) offenders.push("SHELL_FIRST carries a backtick");
  assert.deepEqual(
    offenders,
    [],
    "a backtick inside a brief closes its template literal early; the file stays valid JavaScript and becomes a different program. Use 'single quotes'.",
  );
});
