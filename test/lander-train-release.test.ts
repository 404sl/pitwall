import { strict as assert } from "node:assert";
import test from "node:test";

import { runScript, type Call } from "./support/workflow.js";

const TOKEN = "land-train-1788964650-29574";

const ARGS = {
  skillDir: "/skill",
  root: "/root",
  repo: "site",
  lockToken: TOKEN,
  lockPrefix: "pw",
  repos: { site: { path: "cli", slug: "404sl/pitwall" } },
};

const COMMAND = `bash /skill/release-lock.sh --lock /tmp/pw-merge.lock --token '${TOKEN}'`;

function train(release: unknown) {
  return runScript("land-train.js", ARGS, (call: Call, n: number) => {
    if (n === 1) return { status: "taken", holder: TOKEN };
    if (call.label === "release") return release;
    return { status: "error", notes: "nothing to build" };
  });
}

function releaseStep(calls: Call[]): Call {
  const found = calls.filter((c) => c.label === "release");
  assert.equal(found.length, 1, `expected one release step, got ${calls.map((c) => c.label).join(", ")}`);
  return found[0]!;
}

test("a release step that answered nothing is reported as unattempted, not as a leak", async () => {
  const { done } = train(null);
  const result = (await done) as { lock?: string };
  const lock = result.lock || "";

  assert.match(
    lock,
    /^UNATTEMPTED - /,
    "a release step that never answered came back as something else. A refused Bash call and a " +
      "dead agent both return nothing, and neither says anything about the lock on disk: " +
      `reading that as a leak sends somebody to clear a lock nobody has asked to let go: ${lock}`,
  );
  assert.doesNotMatch(
    lock,
    /LEAKED|clear it by hand/i,
    "a release that never ran reads as a leak, which is the state that needs a person - the two " +
      `must stay apart: ${lock}`,
  );
  assert.ok(lock.endsWith(COMMAND), `the field does not end with the command that releases the lock: ${lock}`);
  assert.ok(
    lock.includes(`removes /tmp/pw-merge.lock only when /tmp/pw-merge.lock/holder reads`),
    `the field does not say why re-running the command is safe: ${lock}`,
  );
});

test("a release step that says its command was refused reports what refused it in the result, not only in the journal", async () => {
  const refusal = "the Bash call was not permitted: [Auto-Mode Bypass]";
  const { logs, done } = train({ status: "unattempted", notes: refusal });
  const result = (await done) as { lock?: string };
  const lock = result.lock || "";

  assert.match(lock, /^UNATTEMPTED - /, lock);
  assert.ok(
    lock.includes(refusal),
    `the result dropped what refused the command, so the supervisor cannot tell a refused call ` +
      `from a dead step: ${lock}`,
  );
  assert.ok(lock.endsWith(COMMAND), `the field does not end with the command that releases the lock: ${lock}`);
  assert.ok(
    logs.some((l) => l.startsWith("UNATTEMPTED - ") && l.includes(refusal)),
    `the journal never said the release was not attempted: ${logs.join(" | ")}`,
  );
});

test("a release step that ran and reported still_held is still a leak", async () => {
  const { done } = train({ status: "still_held", notes: "/tmp/pw-merge.lock held the token and rm could not remove it" });
  const result = (await done) as { lock?: string };
  const lock = result.lock || "";

  assert.match(
    lock,
    /^LEAKED - /,
    `a lock the script ran against and could not remove is the case that needs a person: ${lock}`,
  );
  assert.equal(
    lock.includes("answered nothing"),
    false,
    `LEAKED still ORs a reported still_held together with a step that never ran: ${lock}`,
  );
});

test("the release step is told to report unattempted when its command is not permitted to run", async () => {
  const { calls, done } = train({ status: "released" });
  const result = (await done) as { lock?: string };
  assert.equal(result.lock, "released");

  const prompt = releaseStep(calls).prompt;
  assert.match(
    prompt,
    /report 'unattempted'/,
    "nothing tells the step what to report when its Bash call is refused, so a refusal comes " +
      "back as silence and its words are lost",
  );
  assert.ok(prompt.includes(COMMAND), "the release step was not handed the command with its own token in it");
  assert.equal(prompt.includes("`"), false, "a backtick in the release brief closes its template literal early");

  const schema = releaseStep(calls).schema as { properties: { status: { enum: string[] } } };
  assert.ok(
    schema.properties.status.enum.includes("unattempted"),
    `the release schema has no value for a command that never ran: ${schema.properties.status.enum.join(", ")}`,
  );
});
