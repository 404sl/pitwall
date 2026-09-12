import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import {
  askVersion,
  createRestarter,
  scratchPort,
  type Launch,
  type Launcher,
} from "../src/handover.ts";
import { HOST, listen } from "../src/serve.ts";

const RUNNING = "0.1.2";
const NEWER = "0.1.3";

const WAITS = {
  proveWaitMs: 400,
  takeWaitMs: 400,
  probeEveryMs: 10,
  probeTimeoutMs: 400,
  closeGraceMs: 50,
};

function reporting(version: string): Server {
  return createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ running: version }));
  });
}

function launchOf(server: Server | undefined, port: number, lingerMs: number): Launch {
  let gone: string | undefined;
  let stopping = false;
  let settled: (code: number) => void = () => {};
  const ended = new Promise<number>((done) => {
    settled = done;
  });
  if (server === undefined) {
    gone = "it exited 1";
    settled(1);
  } else {
    void listen(server, port);
  }
  return {
    stop: () => {
      if (gone !== undefined || stopping) {
        return;
      }
      stopping = true;
      setTimeout(() => {
        gone = "it was stopped by SIGTERM";
        server?.close();
        settled(0);
      }, lingerMs);
    },
    gone: () => gone,
    ended,
  };
}

interface Launching {
  launch: Launcher;
  started: Array<{ version: string; port: number }>;
  running: Launch[];
}

function launcher(
  answerWith: (version: string, port: number) => string | undefined,
  lingerMs = 0,
): Launching {
  const started: Array<{ version: string; port: number }> = [];
  const running: Launch[] = [];
  const launch: Launcher = (version, port) => {
    started.push({ version, port });
    const reported = answerWith(version, port);
    const made = launchOf(reported === undefined ? undefined : reporting(reported), port, lingerMs);
    running.push(made);
    return made;
  };
  return { launch, started, running };
}

async function serving(version: string): Promise<{ server: Server; port: number }> {
  const port = await scratchPort();
  const server = reporting(version);
  await listen(server, port);
  return { server, port };
}

function restarterOver(
  server: Server,
  port: number,
  launch: Launcher,
  published: string | undefined,
  lines: string[],
) {
  return createRestarter({
    server,
    port,
    running: RUNNING,
    launch,
    published: () => Promise.resolve(published),
    checkout: () => false,
    log: (line) => lines.push(line),
    ...WAITS,
  });
}

test("a newer version that answers on a scratch port is handed the real port", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher((version) => version);
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });

  const handover = await restarterOver(server, port, launch, NEWER, lines).consider();

  assert.equal(handover.kind, "handed-over");
  assert.equal(server.listening, false);
  assert.equal(started.length, 2);
  assert.equal(started[0]?.version, NEWER);
  assert.notEqual(started[0]?.port, port);
  assert.deepEqual(started[1], { version: NEWER, port });
  assert.equal(await askVersion(port, 400), NEWER);
});

test("the handover says which contract the page it is taking over from was loaded against", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, running } = launcher((version) => version);
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });

  await restarterOver(server, port, launch, NEWER, lines).consider();

  const swap = lines.find((line) => line.includes(SCHEMA_VERSION));
  assert.notEqual(swap, undefined);
  assert.equal(swap?.includes("contract"), true);
});

test("a newer version that never answers never gets the real port", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher(() => undefined);
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });

  const handover = await restarterOver(server, port, launch, NEWER, lines).consider();

  assert.equal(handover.kind, "unproven");
  assert.equal(started.length, 1);
  assert.notEqual(started[0]?.port, port);
  assert.equal(server.listening, true);
  assert.equal(await askVersion(port, 400), RUNNING);
  assert.equal(
    lines.some((line) => line.includes(`Port ${String(port)} stays with ${RUNNING}`)),
    true,
  );
});

test("a version that answers as something else is not the version that was asked for", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher(() => "0.0.1");
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });

  const handover = await restarterOver(server, port, launch, NEWER, lines).consider();

  assert.equal(handover.kind, "unproven");
  assert.equal(
    handover.kind === "unproven" ? handover.why : "",
    `port ${String(started[0]?.port)} answered as 0.0.1, not ${NEWER}`,
  );
  assert.notEqual(started[0]?.port, port);
  assert.equal(server.listening, true);
  assert.equal(await askVersion(port, 400), RUNNING);
});

test("a version proven on the scratch port that then fails to take the real port gives it back", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher((version, at) => (at === port ? undefined : version));
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });

  const handover = await restarterOver(server, port, launch, NEWER, lines).consider();

  assert.equal(handover.kind, "not-taken");
  assert.equal(started.length, 2);
  assert.equal(server.listening, true);
  assert.equal(await askVersion(port, 400), RUNNING);
  assert.equal(
    lines.some((line) => line.includes(`Port ${String(port)} is back with ${RUNNING}`)),
    true,
  );
});

test("the registry is read again at handover time, so a withdrawn release is never restarted onto", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started } = launcher((version) => version);
  t.after(() => server.close());

  const handover = await restarterOver(server, port, launch, RUNNING, lines).consider();

  assert.equal(handover.kind, "nothing-newer");
  assert.deepEqual(started, []);
  assert.equal(server.listening, true);
  assert.deepEqual(lines, []);
});

test("a version that has already failed is not started again", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher(() => undefined);
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });
  const restarter = restarterOver(server, port, launch, NEWER, lines);

  assert.equal((await restarter.consider()).kind, "unproven");
  assert.equal((await restarter.consider()).kind, "already-tried");
  assert.equal(started.length, 1);
  assert.equal(server.listening, true);
});

test("a scratch port is unused and is not the port the console is serving", async () => {
  const first = await scratchPort();
  const second = await scratchPort();
  assert.equal(Number.isInteger(first), true);
  assert.equal(first > 0 && first < 65536, true);
  assert.notEqual(first, second);
  const server = reporting(RUNNING);
  await listen(server, first);
  assert.equal(server.listening, true);
  server.close();
});

test("a port nothing is listening on answers with no version at all", async () => {
  const quiet = await scratchPort();
  assert.equal(await askVersion(quiet, 300), undefined);
  assert.equal(HOST, "127.0.0.1");
});

test("the port is taken back from a failed version that is still holding it, not lost to it", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher((version, at) => (at === port ? "0.0.1" : version), 150);
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });

  const handover = await createRestarter({
    server,
    port,
    running: RUNNING,
    launch,
    published: () => Promise.resolve(NEWER),
    checkout: () => false,
    log: (line) => lines.push(line),
    ...WAITS,
    giveBackTries: 20,
  }).consider();

  assert.equal(handover.kind, "not-taken");
  assert.equal(started.length, 2);
  assert.deepEqual(started[1], { version: NEWER, port });
  assert.equal(server.listening, true);
  assert.equal(await askVersion(port, 400), RUNNING);
  assert.equal(
    lines.some((line) => line.includes(`Port ${String(port)} is back with ${RUNNING}`)),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("serving nothing")),
    false,
  );
});

test("a console running from a git checkout is left alone, and says so once", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started } = launcher((version) => version);
  t.after(() => server.close());
  const restarter = createRestarter({
    server,
    port,
    running: RUNNING,
    launch,
    published: () => Promise.resolve(NEWER),
    checkout: () => true,
    log: (line) => lines.push(line),
    ...WAITS,
  });

  assert.equal((await restarter.consider()).kind, "from-checkout");
  assert.equal((await restarter.consider()).kind, "from-checkout");

  assert.deepEqual(started, []);
  assert.equal(server.listening, true);
  assert.equal(await askVersion(port, 400), RUNNING);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes("git checkout"), true);
  assert.equal(restarter.current(), undefined);
});

test("the child being proved is held, so a stop can reach it, and is let go when it fails", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, started, running } = launcher(() => "0.0.1");
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });
  const restarter = createRestarter({
    server,
    port,
    running: RUNNING,
    launch,
    published: () => Promise.resolve(NEWER),
    checkout: () => false,
    log: (line) => lines.push(line),
    ...WAITS,
    proveWaitMs: 60_000,
  });

  const considering = restarter.consider();
  while (started.length === 0 || restarter.current() === undefined) {
    await new Promise((done) => setTimeout(done, 10));
  }
  const proving = restarter.current();
  assert.equal(proving, running[0]);
  assert.notEqual(started[0]?.port, port);

  proving?.stop();
  const handover = await considering;

  assert.equal(handover.kind, "unproven");
  assert.equal(restarter.current(), undefined);
  assert.equal(started.length, 1);
  assert.equal(server.listening, true);
  assert.equal(await askVersion(port, 400), RUNNING);
});

test("the version that took the real port is the child held after a handover", async (t) => {
  const { server, port } = await serving(RUNNING);
  const lines: string[] = [];
  const { launch, running } = launcher((version) => version);
  t.after(() => {
    for (const made of running) {
      made.stop();
    }
    server.close();
  });
  const restarter = restarterOver(server, port, launch, NEWER, lines);

  const handover = await restarter.consider();

  assert.equal(handover.kind, "handed-over");
  assert.equal(restarter.current(), running[1]);
  assert.equal(handover.kind === "handed-over" ? handover.serving : undefined, running[1]);
});
