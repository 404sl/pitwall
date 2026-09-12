import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

const RELEASE_LOCK = join(SKILL, "release-lock.sh");

function releaseLock(lock: string, token: string) {
  const run = spawnSync("bash", [RELEASE_LOCK, "--lock", lock, "--token", token], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  return { code: run.status, outcome: (run.stdout || "").split("\n")[0], err: run.stderr || "" };
}

function heldLock(token: string | null) {
  const dir = join(mkdtempSync(join(tmpdir(), "lander-lock-")), "merge.lock");
  mkdirSync(dir);
  if (token !== null) writeFileSync(join(dir, "holder"), `${token}\n`);
  return dir;
}

const LAND_ARGS = {
  skillDir: "/skill",
  root: "/root",
  repo: "site",
  repos: { site: { path: "cli", slug: "owner/name" } },
};

const TOKEN = "lander-1788964650-29574";
const TRAIN_TOKEN = "land-train-1788964650-29574";

function landArgs(lockToken: string): Record<string, unknown> {
  return { ...LAND_ARGS, lockToken };
}

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
  const { calls, done } = runScript("land-train.js", landArgs(TRAIN_TOKEN), (call, n) => {
    if (n === 1) return { status: "taken", holder: TRAIN_TOKEN };
    throw new Error("the build agent died mid-run");
  });

  await assert.rejects(done, /died mid-run/);
  assert.ok(
    calls.some((c) => c.label === "release" || /[Rr]elease the serial merge lock/.test(c.prompt)),
    "the lock was taken and never given back: no release step ran when a later step threw. " +
      `Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`,
  );
});

test("land.js puts the token it was launched with into the release command itself", async () => {
  const { calls, done } = runScript("land.js", landArgs(TOKEN), (call, n) => {
    if (n === 1) return { status: "taken", holder: TOKEN };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    return { status: "released" };
  });
  await done;

  assert.ok(
    releasePromptOf(calls).includes(TOKEN),
    "the release step was never handed the token this run took the lock under",
  );
});

test("land-train.js puts the token it was launched with into the release command itself", async () => {
  const { calls, done } = runScript("land-train.js", landArgs(TRAIN_TOKEN), (call, n) => {
    if (n === 1) return { status: "taken", holder: TRAIN_TOKEN };
    return { status: "error", notes: "nothing to build" };
  });
  await done;

  assert.ok(
    releasePromptOf(calls).includes(TRAIN_TOKEN),
    "the release step was never handed the token this train took the lock under",
  );
});

test("each release prompt says the token is already in the command", async () => {
  for (const file of ["land.js", "land-train.js"]) {
    const { calls, done } = runScript(file, landArgs("held-by-this-run"), (call, n) => {
      if (n === 1) return { status: "taken", token: "held-by-this-run", holder: "held-by-this-run" };
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

test("land.js emits no removal command when the holder file read back nothing", async () => {
  const { calls, done } = runScript("land.js", landArgs(TOKEN), (call, n) => {
    if (n === 1) return { status: "taken" };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    return { status: "released" };
  });
  const result = (await done) as { lock?: string };

  assert.equal(
    calls.some((c) => c.label === "release"),
    false,
    "a release step ran for a lock this run cannot prove it owns. A lock step that reports no " +
      "holder at all has shown nothing about what the file on disk says, and an empty holder " +
      "is also how another lander's lock looks between its mkdir and its printf - the lock a " +
      "removal then deletes belongs to somebody else.",
  );

  const removals = calls.filter((c) => c.prompt.includes("release-lock.sh"));
  assert.deepEqual(
    removals.map((c) => c.label),
    [],
    "a removal was handed to an agent with no token to check it against",
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
  const { done } = runScript("land.js", landArgs(TOKEN), (call, n) => {
    if (n === 1) return { status: "taken", holder: TOKEN };
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
    const { done } = runScript("land.js", landArgs(TOKEN), (call, n) => {
      if (n === 1) return { status: "taken", holder: TOKEN };
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

test("neither lander asks a second question after the removal", async () => {
  for (const file of ["land.js", "land-train.js"]) {
    const { calls, done } = runScript(file, landArgs(TOKEN), (call, n) => {
      if (n === 1) return { status: "taken", token: TOKEN, holder: TOKEN };
      if (call.label && call.label.startsWith("survey")) return { prs: [] };
      if (call.label === "release") return { status: "released" };
      return { status: "error", notes: "nothing to build" };
    });
    await done;

    const prompt = releasePromptOf(calls);
    assert.match(
      prompt,
      /bash \/skill\/release-lock\.sh --lock \S+ --token 'lander-1788964650-29574'/,
      `${file} no longer hands the release to one script invocation`,
    );

    for (const reread of [/\[ -d /, /ls -d /, /cat \S*holder/, /rm -rf /, /rmdir /]) {
      assert.doesNotMatch(
        prompt,
        reread,
        `${file}'s release step looks at the lock itself again (${reread}). You cannot verify a ` +
          "release by re-reading the lock afterwards: a queued lander polls mkdir every 0.2s, so " +
          "between our removal and our second look it can already hold the lock - and a reread " +
          "cannot tell that from a removal that failed. It reported STILL_HELD against a live " +
          "foreign lock and named a token no longer in the holder file. The removal and the " +
          "report belong in one process.",
      );
    }
  }
});

test("release-lock.sh removes a lock only when the holder file holds the token", () => {
  const mine = heldLock("lander-1788964650-29574");
  const released = releaseLock(mine, "lander-1788964650-29574");
  assert.equal(released.outcome, "RELEASED", `stdout was ${JSON.stringify(released)}`);
  assert.equal(released.code, 0);
  assert.equal(existsSync(mine), false, "RELEASED was printed over a lock that is still there");

  const theirs = heldLock("lander-1788985671-65481");
  const foreign = releaseLock(theirs, "lander-1788964650-29574");
  assert.equal(foreign.outcome, "NOT_MINE", `stdout was ${JSON.stringify(foreign)}`);
  assert.equal(
    existsSync(theirs),
    true,
    "another lander's lock was removed. A token that does not match the holder file proves " +
      "nothing about ownership, and deleting a live foreign lock puts two landers on one " +
      "repository - the one unrecoverable outcome here.",
  );

  const unstamped = heldLock(null);
  const raced = releaseLock(unstamped, "lander-1788964650-29574");
  assert.equal(raced.outcome, "NOT_MINE", `stdout was ${JSON.stringify(raced)}`);
  assert.equal(
    existsSync(unstamped),
    true,
    "a lock directory with no holder file was removed. That is how another lander's lock looks " +
      "between its mkdir and its printf, so this window belongs to somebody else.",
  );

  const gone = join(mkdtempSync(join(tmpdir(), "lander-lock-")), "merge.lock");
  const absent = releaseLock(gone, "lander-1788964650-29574");
  assert.equal(absent.outcome, "ALREADY_GONE", `stdout was ${JSON.stringify(absent)}`);
  assert.equal(absent.code, 0, "nothing to release is not a failure");

  for (const dir of [theirs, unstamped]) rmSync(dir, { recursive: true, force: true });
});

test("release-lock.sh removes nothing for a token no lander could have minted", () => {
  for (const token of ["", "lander-1 '; touch /tmp/lander-lock-injection-marker; echo '", "lander-1\nlander-2"]) {
    const lock = heldLock("lander-1788964650-29574");
    const run = releaseLock(lock, token);
    assert.notEqual(run.code, 0, `${JSON.stringify(token)} was accepted as a token`);
    assert.match(
      run.err,
      /REFUSED/,
      `release-lock.sh said nothing about refusing ${JSON.stringify(token)}: ${run.err || run.outcome}`,
    );
    assert.equal(
      existsSync(lock),
      true,
      `a lock was removed for token ${JSON.stringify(token)}. An empty token matches a missing ` +
        "or empty holder file, and a token carrying a quote or a newline is not a string any " +
        "lock step wrote - neither proves ownership of anything.",
    );
    rmSync(lock, { recursive: true, force: true });
  }
});

test("land-train.js tells a stand-down apart from a leak in its own result", async () => {
  const outcomes: Record<string, RegExp> = {
    released: /^released$/,
    not_mine: /not_mine/,
    already_gone: /already_gone/,
    still_held: /LEAKED/,
  };
  for (const [status, expected] of Object.entries(outcomes)) {
    const { done } = runScript("land-train.js", landArgs(TRAIN_TOKEN), (call, n) => {
      if (n === 1) return { status: "taken", holder: TRAIN_TOKEN };
      if (call.label === "release") return { status };
      return { status: "error", notes: "nothing to build" };
    });
    const result = (await done) as { lock?: string };

    assert.match(result.lock || "", expected, `a release that reported ${status} came back as ${result.lock}`);
    if (status !== "still_held") {
      assert.doesNotMatch(
        result.lock || "",
        /LEAKED|clear it by hand/i,
        `${status} came back as a leak to clear by hand. The train folded every release answer ` +
          "into released-or-LEAKED, so a lock another train legitimately holds read as one for a " +
          "person to delete - and that deletion is the unrecoverable one.",
      );
    }
  }
});

test("land-train.js emits no removal command when the holder file read back nothing", async () => {
  const { calls, done } = runScript("land-train.js", landArgs(TRAIN_TOKEN), (call, n) => {
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

  const removals = calls.filter((c) => c.prompt.includes("release-lock.sh"));
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

test("neither lander works under a token the holder file does not hold", async () => {
  const mine = "lander-1788974078-40586";
  const theirs = "lander-1788975899-51221";
  for (const file of ["land.js", "land-train.js"]) {
    const { calls, done } = runScript(file, landArgs(mine), (call, n) => {
      if (n === 1) return { status: "taken", token: mine, holder: theirs };
      if (call.label && call.label.startsWith("survey")) return { prs: [] };
      return { status: "error", notes: "nothing to build" };
    });
    const result = (await done) as { lock?: string };

    assert.equal(
      calls.length,
      1,
      `${file} carried on past a lock step whose holder file read back another run's token. ` +
        `Steps seen: ${calls.map((c) => c.label || "?").join(", ")}. Two runs half an hour apart ` +
        "reported the same token, so a reported token is a claim and the holder file is the fact. " +
        "A run that cannot match the two is not holding the lock and must land nothing.",
    );

    assert.deepEqual(
      calls.filter((c) => c.prompt.includes("release-lock.sh")).map((c) => c.label),
      [],
      `${file} offered a removal for a lock whose holder file names a different token. ` +
        "Release-by-token is the ownership guard everywhere, so handing this token to the " +
        "removal deletes the lock of whichever run actually minted it, mid-merge.",
    );

    assert.match(result.lock || "", /LEAKED/, `${file} returned without saying the lock was left standing`);
    assert.ok(
      (result.lock || "").includes(theirs) && (result.lock || "").includes(mine),
      `${file} quoted neither the holder file nor the token it wrote, so nobody reading the ` +
        `result can tell which run to leave alone: ${result.lock}`,
    );
  }
});

test("neither lander stands down over the newline cat prints", async () => {
  const mine = "lander-1788974078-40586";
  for (const file of ["land.js", "land-train.js"]) {
    for (const reported of [
      { token: mine, holder: `${mine}\n` },
      { token: `${mine}\n`, holder: `${mine}\n` },
    ]) {
      const { calls, done } = runScript(file, landArgs(mine), (call, n) => {
        if (n === 1) return { status: "taken", ...reported };
        if (call.label && call.label.startsWith("survey")) return { prs: [] };
        if (call.label === "release") return { status: "released" };
        return { status: "error", notes: "nothing to build" };
      });
      const result = (await done) as { lock?: string };

      assert.ok(
        calls.length > 1,
        `${file} stood down over ${JSON.stringify(reported)}, where the only difference is the ` +
          "newline the holder file ends with and cat prints back. The lock step is told to report " +
          "what cat printed verbatim and untidied, so that newline is the expected answer, not a " +
          "foreign lander - and standing down here halts every merge while telling the operator " +
          `the lock belongs to somebody else. Steps seen: ${calls.map((c) => c.label || "?").join(", ")}`,
      );

      assert.match(
        releasePromptOf(calls),
        new RegExp(`--token '${mine}'`),
        `${file} handed the removal a token the holder file cannot match. release-lock.sh refuses ` +
          "a token carrying a newline, so the lock would be left standing by the very step that " +
          "exists to give it back.",
      );

      assert.doesNotMatch(
        result.lock || "",
        /LEAKED/,
        `${file} reported a leak for a lock it holds and released`,
      );
    }
  }
});

test("land-train.js reads the holder file before it stands down for another lander", async () => {
  const theirs = "land-train-1788975899-51221";
  const { calls, done } = runScript("land-train.js", landArgs(TRAIN_TOKEN), (call, n) => {
    if (n === 1) return { status: "held", holder: `${theirs}\n` };
    return { status: "error", notes: "nothing to build" };
  });
  const result = (await done) as { status?: string; notes?: string };

  const prompt = lockPromptOf(calls);
  const opens = prompt.indexOf("If it prints HELD");
  const closes = prompt.indexOf("If it prints TAKEN");
  assert.ok(opens >= 0 && closes > opens, "the lock prompt no longer branches on HELD and TAKEN");
  assert.ok(
    prompt.slice(opens, closes).includes("cat /tmp/devloop-merge.lock/holder"),
    "the HELD branch never reads the holder file, and the step's schema requires 'holder' of " +
      "every outcome it can report. HELD is ordinary contention, not an edge case, so the step " +
      "is asked for a value it was given no way to obtain - it either fills in the one field " +
      "ownership is decided from or burns its retries and answers nothing.",
  );

  assert.equal(calls.length, 1, `the train carried on past a lock it does not hold: ${calls.map((c) => c.label || "?").join(", ")}`);
  assert.equal(result.status, "held");
  assert.ok(
    (result.notes || "").includes(theirs),
    `the train required a holder of the lock step and then threw it away: ${result.notes}. A run ` +
      "that says only 'another lander holds it' cannot be told from one standing down over a " +
      "lock nobody owns.",
  );
});

const LAUNCHERS: Record<string, RegExp> = {
  "land.js": /config\.sh --land/,
  "land-train.js": /config\.sh --train/,
};

function refusal(result: { error?: string; notes?: string }): string {
  return result.error || result.notes || "";
}

test("neither lander takes the lock when args carry no token", async () => {
  for (const [file, launcher] of Object.entries(LAUNCHERS)) {
    const { calls, done } = runScript(file, LAND_ARGS, () => {
      throw new Error("a step ran for a launch that should have been refused");
    });
    const result = (await done) as { error?: string; notes?: string };

    assert.equal(
      calls.length,
      0,
      `${file} launched with no lockToken still ran a step. The refusal has to land before the ` +
        "lock is taken, the way the missing-slug block does: a run that mkdirs the lock and only " +
        "then aborts leaves it standing for a release step that never runs.",
    );
    assert.match(
      refusal(result),
      /lockToken/,
      `the refusal never names the argument that is missing: ${JSON.stringify(result)}`,
    );
    assert.match(
      refusal(result),
      launcher,
      `${file} names no way to get a token, so whoever launched it by hand is left guessing at ` +
        "a field it will not mint for itself",
    );
  }
});

test("neither lander accepts a token it could not quote back into a shell command", async () => {
  for (const file of Object.keys(LAUNCHERS)) {
    for (const bad of ["lander-1'; touch /tmp/lander-lock-injection-marker #", "lander-1\nlander-2", "   "]) {
      const { calls, done } = runScript(file, landArgs(bad), () => {
        throw new Error("a step ran for a launch that should have been refused");
      });
      const result = (await done) as { error?: string; notes?: string };

      assert.equal(
        calls.length,
        0,
        `${file} took the lock under ${JSON.stringify(bad)}. The token is interpolated into a ` +
          "single-quoted shell argument in both the lock step and the removal, so a quote in it " +
          "closes the quoting and the rest becomes a command of its own - against the lock that " +
          "serialises every merge and deploy. Moving the mint into args moved that vector from " +
          "the agent's answer to the args object, and the check has to move with it.",
      );
      assert.match(
        refusal(result),
        /lockToken/,
        `the refusal never names the argument it rejected: ${JSON.stringify(result)}`,
      );
    }
  }
});

test("land.js writes the token it was launched with and hands the same one to the removal", async () => {
  const { calls, done } = runScript("land.js", landArgs(TOKEN), (call, n) => {
    if (n === 1) return { status: "taken", holder: `${TOKEN}\n` };
    if (call.label && call.label.startsWith("survey")) return { prs: [] };
    if (call.label === "release") return { status: "released" };
    return {};
  });
  const result = (await done) as { lock?: string };

  const lock = lockPromptOf(calls);
  const command = lock.slice(0, lock.indexOf("echo GOT_MERGE_LOCK"));
  assert.ok(
    command.includes(`'${TOKEN}' > /tmp/devloop-merge.lock/holder`),
    `the lock step writes something other than the token it was launched with:\n${lock}`,
  );
  assert.doesNotMatch(
    command,
    /date \+%s|\$\$/,
    "the lock step still mints its own token inside the command it runs. Every value such a " +
      "step reports comes from one answer, so a replayed acquisition agrees with itself and " +
      "nothing in the script can tell it from a fresh one - the run then believes it holds a " +
      "lock that may be free or another lander's, and merges unserialised.",
  );
  assert.equal(
    (calls[0]?.schema as { properties?: Record<string, unknown> } | undefined)?.properties?.["token"],
    undefined,
    "the lock step is still asked to report the token it wrote. The run does not read it any " +
      "more, and a field nobody checks is exactly the stale claim this change removes.",
  );
  assert.match(
    releasePromptOf(calls),
    new RegExp(`--token '${TOKEN}'`),
    "the removal was handed a different token from the one written into the holder file, so " +
      "release-lock.sh finds no match and the lock is left standing by the step that exists to " +
      "give it back",
  );
  assert.equal(result.lock, "released", `the run did not report the lock released: ${result.lock}`);
});

test("land-train.js writes the token it was launched with and hands the same one to the removal", async () => {
  const { calls, done } = runScript("land-train.js", landArgs(TRAIN_TOKEN), (call, n) => {
    if (n === 1) return { status: "taken", holder: `${TRAIN_TOKEN}\n` };
    if (call.label === "release") return { status: "released" };
    return { status: "error", notes: "nothing to build" };
  });
  const result = (await done) as { lock?: string };

  const lock = lockPromptOf(calls);
  const command = lock.slice(0, lock.indexOf("THE TOKEN IS ALREADY IN THAT COMMAND"));
  assert.ok(
    command.includes(`'${TRAIN_TOKEN}' > /tmp/devloop-merge.lock/holder`),
    `the lock step writes something other than the token it was launched with:\n${lock}`,
  );
  assert.doesNotMatch(
    command,
    /date \+%s|\$\$/,
    "the lock step still mints its own token inside the command it runs. Every value such a " +
      "step reports comes from one answer, so a replayed acquisition agrees with itself and " +
      "nothing in the script can tell it from a fresh one - the train then believes it holds a " +
      "lock that may be free or another lander's, and merges unserialised.",
  );
  assert.equal(
    (calls[0]?.schema as { properties?: Record<string, unknown> } | undefined)?.properties?.["token"],
    undefined,
    "the lock step is still asked to report the token it wrote. The train does not read it any " +
      "more, and a field nobody checks is exactly the stale claim this change removes.",
  );
  assert.match(
    releasePromptOf(calls),
    new RegExp(`--token '${TRAIN_TOKEN}'`),
    "the removal was handed a different token from the one written into the holder file, so " +
      "release-lock.sh finds no match and the lock is left standing by the step that exists to " +
      "give it back",
  );
  assert.equal(result.lock, "released", `the train did not report the lock released: ${result.lock}`);
});

test("every instruction to launch a train goes through config.sh --train", () => {
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const at = skill.indexOf("config.sh --train");
  assert.ok(
    at > 0,
    "SKILL.md documents no way to launch a train through config.sh --train. That command mints " +
      "the merge-lock token the train holds, and land-train.js refuses to start without one - " +
      "a documented launch that skips it cannot land anything, and until 2026-09-12 there was " +
      "no documented launch at all.",
  );
  assert.match(
    skill.slice(at, at + 400),
    /args: <the object config\.sh printed>/,
    "the documented launch no longer passes the object config.sh printed, so a supervisor " +
      "following it assembles args by hand and leaves out the token",
  );
});

test("every instruction to launch the lander goes through config.sh --land", () => {
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const at = skill.indexOf("config.sh --land");
  assert.ok(
    at > 0,
    "SKILL.md no longer builds the lander dispatch with config.sh --land. That command mints " +
      "the merge-lock token the run holds, and land.js refuses to start without one - a " +
      "documented launch that skips it cannot land anything.",
  );
  assert.match(
    skill.slice(at, at + 400),
    /args: <the object config\.sh printed>/,
    "the documented launch no longer passes the object config.sh printed, so a supervisor " +
      "following it assembles args by hand and leaves out the token",
  );

  const scan = readFileSync(join(SKILL, "triage-scan.sh"), "utf8");
  for (const marker of ["LANDER IDLE:", "LANDER STALL?:"]) {
    const found = scan.indexOf(marker);
    assert.ok(found > 0, `triage-scan.sh no longer reports ${marker}`);
    const finding = scan.slice(found, scan.indexOf("sys.exit(1)", found));
    assert.match(
      finding,
      /config\.sh --land/,
      `${marker} tells a supervisor to relaunch the lander without naming the command that ` +
        "mints its merge-lock token. land.js refuses a launch that carries none, so the advice " +
        "as it stands produces a run that does nothing.",
    );
  }
});
