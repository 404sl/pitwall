import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { serveLifecycle, type StopSignal } from "../src/cli.ts";
import { createRestarter, scratchPort, type Launch, type Launcher } from "../src/handover.ts";
import { listen } from "../src/serve.ts";

const RUNNING = "0.1.2";
const NEWER = "0.1.3";
const PORT = 7373;

interface Stub {
  launch: Launch;
  stops: () => number;
  end: (code: number) => void;
}

function stub(): Stub {
  let gone: string | undefined;
  let stops = 0;
  let settle: (code: number) => void = () => {};
  const ended = new Promise<number>((done) => {
    settle = done;
  });
  const finish = (why: string, code: number) => {
    if (gone !== undefined) {
      return;
    }
    gone = why;
    settle(code);
  };
  return {
    launch: {
      stop: () => {
        stops += 1;
        setTimeout(() => finish("it was stopped by SIGTERM", 143), 0);
      },
      gone: () => gone,
      ended,
    },
    stops: () => stops,
    end: (code: number) => finish(`it exited ${String(code)}`, code),
  };
}

function tick(): Promise<void> {
  return new Promise((done) => setTimeout(done, 5));
}

interface Watching {
  handlers: Map<StopSignal, () => void>;
  lines: string[];
  exits: number[];
}

function watching(port: number, current: () => Launch | undefined): Watching & { follow: (version: string, serving: Launch) => void } {
  const handlers = new Map<StopSignal, () => void>();
  const lines: string[] = [];
  const exits: number[] = [];
  const { follow } = serveLifecycle({
    port,
    current,
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    on: (signal, handler) => handlers.set(signal, handler),
    sleep: () => Promise.resolve(),
  });
  return { handlers, lines, exits, follow };
}

test("a stop during the proving window reaches the child that was being proved", async (t) => {
  const port = await scratchPort();
  const server = createServer((_req, res) => {
    res.end("{}");
  });
  await listen(server, port);
  t.after(() => server.close());
  const made: Stub[] = [];
  const launch: Launcher = () => {
    const one = stub();
    made.push(one);
    return one.launch;
  };
  const restarter = createRestarter({
    server,
    port,
    running: RUNNING,
    launch,
    published: () => Promise.resolve(NEWER),
    checkout: () => false,
    ask: () => Promise.resolve("0.0.1"),
    log: () => {},
    proveWaitMs: 60_000,
    takeWaitMs: 400,
    probeEveryMs: 10,
    probeTimeoutMs: 50,
    closeGraceMs: 20,
  });
  const { handlers, exits } = watching(port, () => restarter.current());

  const considering = restarter.consider();
  for (let i = 0; i < 100 && restarter.current() === undefined; i += 1) {
    await tick();
  }
  assert.notEqual(restarter.current(), undefined);
  handlers.get("SIGTERM")?.();
  assert.equal(made.length, 1);
  assert.equal(made[0]?.stops(), 1);
  await tick();

  assert.equal(made[0]?.launch.gone(), "it was stopped by SIGTERM");
  assert.deepEqual(exits, [0]);
  assert.equal((await considering).kind, "unproven");
  assert.equal(server.listening, true);
});

test("a proven version that dies after taking the port says the port is no longer served", async () => {
  const one = stub();
  const { lines, exits, follow } = watching(PORT, () => one.launch);

  follow(NEWER, one.launch);
  one.end(1);
  await tick();

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes(`Port ${String(PORT)}: ${NEWER} stopped (exit 1)`), true);
  assert.equal(lines[0]?.includes("Nothing is serving"), true);
  assert.deepEqual(exits, [1]);
});

test("a console stopped on purpose does not report the version it was serving as lost", async () => {
  const one = stub();
  const { handlers, lines, exits, follow } = watching(PORT, () => one.launch);

  follow(NEWER, one.launch);
  handlers.get("SIGINT")?.();
  await tick();

  assert.deepEqual(lines, []);
  assert.equal(one.stops(), 1);
  assert.equal(await one.launch.ended, 143);
  assert.deepEqual([...new Set(exits)], [0]);
});

test("a stop with no newer version running exits without waiting for one", () => {
  const handlers = new Map<StopSignal, () => void>();
  const exits: number[] = [];
  serveLifecycle({
    port: PORT,
    current: () => undefined,
    log: () => {},
    exit: (code) => exits.push(code),
    on: (signal, handler) => handlers.set(signal, handler),
    sleep: () => {
      throw new Error("nothing should be waited for when no child is running");
    },
  });

  handlers.get("SIGINT")?.();

  assert.deepEqual(exits, [0]);
  assert.deepEqual([...handlers.keys()], ["SIGINT", "SIGTERM", "SIGHUP"]);
});
