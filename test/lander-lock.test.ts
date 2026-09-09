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

test("land.js does not tell a supervisor to clear a lock another run holds", async () => {
  const { done } = runScript("land.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574" };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    if (call.label === "release") return { status: "not_mine" };
    return {};
  });
  const result = (await done) as { lock?: string };

  assert.doesNotMatch(
    result.lock || "",
    /LEAKED|clear it by hand/i,
    "a release step that reported not_mine came back as a leak to clear by hand. The release " +
      "prompt calls not_mine a correct outcome - something else holds the lock and will give " +
      "it back - so telling a supervisor to remove it is an instruction to delete a live " +
      "foreign lock, which is the one unrecoverable outcome here.",
  );
  assert.match(
    result.lock || "",
    /not_mine/,
    "the result threw away the distinction the release schema draws: a supervisor cannot tell " +
      "a stand-down from a release without it.",
  );
});

test("land.js reports a lock it could not give back as leaked", async () => {
  for (const reply of [{ status: "still_held" }, {}, undefined]) {
    const { done } = runScript("land.js", LAND_ARGS, (call, n) => {
      if (n === 1) return { status: "taken", token: "lander-1788964650-29574" };
      if (call.label && call.label.startsWith("survey")) return { prs: [] };
      if (call.label === "release") return reply;
      return {};
    });
    const result = (await done) as { lock?: string };

    assert.match(
      result.lock || "",
      /LEAKED/,
      `a release step that answered ${JSON.stringify(reply)} left the lock standing, and the ` +
        "run still has to say so in its result - the reported incident is a lander returning " +
        "success while holding the lock.",
    );
  }
});

test("land.js settles NOT_MINE before it asks for a confirmation", async () => {
  const { calls, done } = runScript("land.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken", token: "lander-1788964650-29574" };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    return { status: "released" };
  });
  await done;

  const prompt = releasePromptOf(calls);
  const confirmAt = prompt.indexOf("[ -d /tmp/devloop-merge.lock ]");
  const stopAt = prompt.search(/do not run the confirm/i);

  assert.notEqual(confirmAt, -1, "the release prompt no longer confirms the lock is gone");
  assert.ok(
    stopAt !== -1 && stopAt < confirmAt,
    "a holder mismatch prints NOT_MINE and then the confirmation prints STILL_HELD, so both " +
      "reporting rules apply at once and the agent picks one. The prompt has to settle " +
      "NOT_MINE before it asks for a confirmation, or the two statuses mean nothing.",
  );
});

test("land-train.js emits no removal command when the lock step reported no token", async () => {
  const { calls, done } = runScript("land-train.js", LAND_ARGS, (call, n) => {
    if (n === 1) return { status: "taken" };
    return { status: "error", notes: "nothing to build" };
  });
  const result = (await done) as { lock?: string };

  assert.equal(
    calls.some((c) => c.label === "release"),
    false,
    "a release step ran for a lock this run cannot prove it owns. Its guard compares the " +
      "holder file against an empty EXPECTED, and the same prompt tells the agent not to stop " +
      "for want of a token - two instructions pointing opposite ways over a lock that may be " +
      "somebody else's.",
  );

  const removals = calls.filter((c) => /rm -f |rmdir /.test(c.prompt));
  assert.deepEqual(
    removals.map((c) => c.label),
    [],
    "a removal was handed to an agent with no token to check it against",
  );

  assert.match(
    result.lock || "",
    /LEAKED/,
    "the train returned without saying it was still holding the lock",
  );
});
