import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: {
    site: { path: "cli", slug: "acme/thing", test: "npm test", role: "node" },
    integration: { path: "schema", slug: "acme/thing-schema", test: "npm test", role: "node" },
  },
};

const TRIAGE_OK = {
  eligible: true,
  repo: "site",
  title: "a path is read from the wrong checkout",
  priority: 1,
  ui: false,
  reason: "",
  ticket: "the ticket body names src/notify.ts",
};

const PARKED = { verification: "zz-aaa1 [BUG] open needs-decision\nAssignee: pw-devloop" };
const RELEASED = { lane: "released", slot: "released" };

function labels(calls: Call[]): string[] {
  return calls.map((c) => c.label);
}

function triagePrompt(calls: Call[]): string {
  const found = calls.find((c) => c.label === "triage:zz-aaa1");
  assert.ok(found, `no triage step ran. Steps seen: ${labels(calls).join(", ")}`);
  return found.prompt;
}

test("a repo key the configuration does not have is refused before any worktree is cut", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return { ...TRIAGE_OK, repo: "extension" };
    if (call.label.startsWith("handover:")) return PARKED;
    return RELEASED;
  });

  const result = await done;

  assert.equal(
    labels(calls).filter((l) => l.startsWith("fix:")).length,
    0,
    "the fix step ran against a repo with no checkout behind it",
  );
  assert.ok(
    labels(calls).some((l) => l.startsWith("handover:")),
    `the misroute was not handed to a person. Steps seen: ${labels(calls).join(", ")}`,
  );
  assert.equal(result["outcome"], "needs_feedback");
  const question = String(result["question"]);
  assert.match(question, /'extension'/, "the question does not name the key that was wrong");
  assert.match(question, /site, integration/, "the question does not list the configured keys");
});

test("the refusal is parked, so the queue does not offer the issue straight back out", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return { ...TRIAGE_OK, repo: "extension" };
    if (call.label.startsWith("handover:")) return PARKED;
    return RELEASED;
  });

  await done;
  const handover = calls.find((c) => c.label.startsWith("handover:"));
  assert.ok(handover);
  assert.match(
    handover.prompt,
    /bd label add zz-aaa1/,
    "the handover does not park the issue, so it is dispatched again next tick",
  );
});

test("'unknown' is an enum member and not a route", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return { ...TRIAGE_OK, repo: "unknown" };
    if (call.label.startsWith("handover:")) return PARKED;
    return RELEASED;
  });

  const result = await done;
  assert.equal(labels(calls).filter((l) => l.startsWith("fix:")).length, 0);
  assert.equal(result["outcome"], "needs_feedback");
});

test("a configured key still reaches the work", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "no_change_needed", summary: "the premise did not hold" };
    return RELEASED;
  });

  const result = await done;
  assert.ok(
    labels(calls).some((l) => l.startsWith("fix:")),
    `a correctly routed issue never reached the work. Steps seen: ${labels(calls).join(", ")}`,
  );
  assert.equal(result["outcome"], "no_change_needed");
});

const SPLIT_PLAN = [
  { title: "the contract field", repo: "integration", scope: "adds a field", autonomous: true },
  { title: "the consumer", repo: "site", scope: "reads it", autonomous: true },
];

test("a split whose child is routed at a key the configuration lacks is refused, not created", async () => {
  const plan = [SPLIT_PLAN[0], { ...SPLIT_PLAN[1], repo: "extension" }];
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) {
      return { ...TRIAGE_OK, eligible: false, splittable: true, reason: "two repositories", splitPlan: plan };
    }
    if (call.label.startsWith("handover:")) return PARKED;
    return RELEASED;
  });

  const result = await done;
  assert.equal(
    labels(calls).filter((l) => l.startsWith("split:")).length,
    0,
    "children were created for a repo this workspace has no checkout for",
  );
  assert.equal(result["outcome"], "needs_feedback");
  assert.match(String(result["question"]), /'extension'/);
});

test("a split whose children are all configured still splits", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) {
      return { ...TRIAGE_OK, eligible: false, splittable: true, reason: "two repositories", splitPlan: SPLIT_PLAN };
    }
    if (call.label.startsWith("split:")) return "created zz-aaa1.1 and zz-aaa1.2";
    return RELEASED;
  });

  const result = await done;
  assert.equal(result["outcome"], "split");
  const split = calls.find((c) => c.label.startsWith("split:"));
  assert.ok(split);
  assert.match(
    split.prompt,
    /Repo: <the key listed for that child above>/,
    "a split no longer carries the parent routing into each child, so the child that ships has none",
  );
  assert.match(
    split.prompt,
    /repo: integration \(\/root\/schema\)/,
    "the child listing does not name the checkout the child is routed at",
  );
});

test("a genuine bounce keeps its own reason rather than the routing one", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) {
      return { ...TRIAGE_OK, eligible: false, reason: "it decides what a customer is charged" };
    }
    if (call.label.startsWith("handover:")) return PARKED;
    return RELEASED;
  });

  const result = await done;
  assert.equal(result["question"], "it decides what a customer is charged");
  void labels(calls);
});

test("triage is shown the checkouts it must route against, not another workspace's repositories", () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_OK;
    if (n === 2) return { status: "no_change_needed", summary: "nothing to do" };
    return RELEASED;
  });

  return done.then(() => {
    const prompt = triagePrompt(calls);
    assert.match(prompt, /site {2}-> {2}\/root\/cli {2}\(acme\/thing\)/);
    assert.match(prompt, /integration {2}-> {2}\/root\/schema {2}\(acme\/thing-schema\)/);
    assert.doesNotMatch(
      prompt,
      /Chrome extension/,
      "the routing instruction still describes another workspace's repositories, which is what made triage guess",
    );
    assert.match(prompt, /ONLY A KEY FROM THAT TABLE MAY BE RETURNED/);
    assert.match(prompt, /DERIVE THE KEY FROM THE SOURCE PATHS THE TICKET NAMES/);
    assert.match(prompt, /CONFIRMATION, NOT AUTHORITY/);
    assert.match(prompt, /THAT IS A STOP, NOT A TIEBREAK/);
  });
});

test("the routing instruction hands out no 2>&1 and no backticks", () => {
  const source = readFileSync(join(SKILL, "task.js"), "utf8");
  const start = source.indexOf("ROUTE IT FROM THE PATHS THE TICKET NAMES");
  assert.notEqual(start, -1, "the routing instruction moved - update this test rather than deleting it");
  const end = source.indexOf("Set 'ui' true only when", start);
  assert.notEqual(end, -1, "could not find the end of the routing instruction");
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /2>&1/, "a step is told to merge stderr, which breaks other tools in this workspace");
  assert.deepEqual(
    block.split("\n").filter((line) => line.includes("`") && !line.includes("${")),
    [],
    "a backtick inside the brief closes its template literal early",
  );
});
