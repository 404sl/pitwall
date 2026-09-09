import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Call = { prompt: string; label: string };

function runScript(file: string, args: unknown, reply: (call: Call, n: number) => unknown) {
  const source = readFileSync(join(SKILL, file), "utf8").replace(/^export const /m, "const ");
  const calls: Call[] = [];
  const body = new AsyncFunction("args", "agent", "phase", "log", "parallel", source);
  const agent = async (prompt: string, opts: { label?: string } = {}) => {
    const call = { prompt, label: opts.label || "" };
    calls.push(call);
    return reply(call, calls.length);
  };
  const noop = () => {};
  return { calls, done: body(args, agent, noop, noop, noop) };
}

const LAND_ARGS = {
  skillDir: "/skill",
  root: "/root",
  repos: { site: { path: "cli", slug: "owner/name" } },
};

function releasePromptOf(calls: Call[]): string {
  const found = calls.filter((c) => c.label === "release");
  const only = found[0];
  assert.ok(only, `expected a release step, got ${calls.map((c) => c.label).join(",")}`);
  assert.equal(found.length, 1, "expected exactly one release step");
  return only.prompt;
}

function lockPromptOf(calls: Call[]): string {
  const first = calls[0];
  assert.ok(first, "the lock step never ran");
  return first.prompt;
}

test("land-train.js releases the merge lock when a step throws", async () => {
  const { calls, done } = runScript("land-train.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken", token: "land-train-1-aaaaaa" };
    throw new Error("the build agent died mid-run");
  });

  await assert.rejects(done, /died mid-run/);
  assert.ok(
    calls.some((c) => c.label === "release" || /[Rr]elease the serial merge lock/.test(c.prompt)),
    "the lock was taken and never given back: no release step ran when a later step threw. " +
      `Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`,
  );
});

test("land.js puts the reported token into the release command itself", async () => {
  const { calls, done } = runScript("land.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574" };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    return { status: "released" };
  });
  await done;

  assert.ok(
    releasePromptOf(calls).includes("lander-1788964650-29574"),
    "the release step was never handed the token the lock step reported",
  );
});

test("land-train.js puts the reported token into the release command itself", async () => {
  const { calls, done } = runScript("land-train.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken", token: "land-train-1788964650-29574" };
    return { status: "error", notes: "nothing to build" };
  });
  await done;

  assert.ok(
    releasePromptOf(calls).includes("land-train-1788964650-29574"),
    "the release step was never handed the token the lock step reported",
  );
});

test("each release prompt says the token is already in the command", async () => {
  for (const file of ["land.js", "land-train.js"]) {
    const { calls, done } = runScript(file, LAND_ARGS, (call, n) => {
      if (n === 1) return { status: "taken", token: "held-by-this-run" };
      if (call.label && call.label.startsWith("survey")) return { prs: [] };
      return { status: "error", notes: "nothing to build" };
    });
    await done;

    assert.match(
      releasePromptOf(calls),
      /exactly as it stands/i,
      `${file} no longer tells the release agent to run the command as written. The wording it ` +
        'replaced was "substitute the token the lock step reported", which an agent read as an ' +
        "instruction to go and find one - it decided it had been given nothing, refused to " +
        "release a lock it was holding, and the run reported success anyway.",
    );

    assert.equal(
      readFileSync(join(SKILL, file), "utf8").includes("THE-TOKEN-WAS-NOT-CARRIED"),
      false,
      `${file} still falls back to a sentinel token. A release agent handed one compares it ` +
        "against the holder file, finds no match, and correctly refuses - a guaranteed leak.",
    );
  }
});

test("no lander calls a global the workflow sandbox refuses", () => {
  for (const file of ["land.js", "land-train.js", "task.js", "rework.js"]) {
    const source = readFileSync(join(SKILL, file), "utf8");
    const banned = source.match(/\bDate\.now\(\)|\bMath\.random\(\)|\bnew Date\(\s*\)/g);
    assert.deepEqual(
      banned,
      null,
      `${file} calls ${banned && banned.join(", ")}, which throws in the workflow runner - it ` +
        "would break resume. The whole script dies on the first line that reaches one, and " +
        "node --check, lint and CI all stay green. Pass a timestamp through args instead.",
    );
  }
});

test("land.js emits no removal command when the lock step reported no token", async () => {
  const { calls, done } = runScript("land.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken" };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    return { status: "released" };
  });
  const result = (await done) as { lock?: string };

  assert.equal(
    calls.some((c) => c.label === "release"),
    false,
    "a release step ran for a lock this run cannot prove it owns. With no token the guard " +
      "compares the holder file against an empty string, which matches whenever the holder " +
      "file is missing or empty - a window that opens between another lander's mkdir and its " +
      "printf - and the lock it then deletes belongs to somebody else.",
  );

  const removals = calls.filter((c) => c.prompt.includes("rm -rf"));
  assert.deepEqual(
    removals.map((c) => c.label),
    [],
    "an rm was handed to an agent with no token to check it against",
  );

  assert.match(
    result.lock || "",
    /LEAKED/,
    "the run returned success while still holding the lock. That is the reported incident: a " +
      "journal line a person reads afterwards is not what the supervisor consumes, so the " +
      "leak has to be in the result.",
  );
});
