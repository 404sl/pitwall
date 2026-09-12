import { spawn } from "node:child_process";
import { createServer as createSocket } from "node:net";
import type { Server } from "node:http";
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import { newerThan, readPublished } from "./registry.js";
import { HOST, VERSION_ROUTE, listen } from "./serve.js";
import { VERSION } from "./version.js";

export const PACKAGE = "@404sl/pitwall";
export const CONSIDER_EVERY_MS = 3_600_000;
export const PROVE_WAIT_MS = 300_000;
export const TAKE_WAIT_MS = 30_000;
export const PROBE_EVERY_MS = 500;
export const PROBE_TIMEOUT_MS = 2_000;
export const CLOSE_GRACE_MS = 2_000;
export const GIVE_BACK_TRIES = 20;

export interface Launch {
  stop: () => void;
  gone: () => string | undefined;
  ended: Promise<number>;
}

export type Launcher = (version: string, port: number) => Launch;

export type Ask = (port: number, timeoutMs: number) => Promise<string | undefined>;

export type Handover =
  | { kind: "handed-over"; version: string; serving: Launch }
  | { kind: "nothing-newer" }
  | { kind: "already-tried"; version: string }
  | { kind: "in-flight" }
  | { kind: "unproven"; version: string; why: string }
  | { kind: "not-taken"; version: string; why: string };

export interface RestartOptions {
  server: Server;
  port: number;
  running?: string;
  launch?: Launcher;
  ask?: Ask;
  published?: () => Promise<string | undefined>;
  scratchPort?: () => Promise<number>;
  proveWaitMs?: number;
  takeWaitMs?: number;
  probeEveryMs?: number;
  probeTimeoutMs?: number;
  closeGraceMs?: number;
  giveBackTries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Restarter {
  consider: () => Promise<Handover>;
}

export function scratchPort(): Promise<number> {
  return new Promise((done, failed) => {
    const socket = createSocket();
    socket.once("error", (cause: Error) => failed(cause));
    socket.listen(0, HOST, () => {
      const address = socket.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      socket.close((cause) => {
        if (port === 0) {
          failed(cause ?? new Error("no unused port could be opened"));
          return;
        }
        done(port);
      });
    });
  });
}

export async function askVersion(port: number, timeoutMs: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://${HOST}:${String(port)}${VERSION_ROUTE}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return undefined;
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return undefined;
    }
    const { running } = body as { running?: unknown };
    return typeof running === "string" ? running : undefined;
  } catch {
    return undefined;
  }
}

export function npxLaunch(version: string, port: number): Launch {
  const child = spawn("npx", ["--yes", `${PACKAGE}@${version}`, "serve", "--port", String(port)], {
    stdio: "inherit",
    detached: true,
  });
  let gone: string | undefined;
  const ended = new Promise<number>((done) => {
    child.once("error", (cause: Error) => {
      gone = `it could not be started: ${cause.message}`;
      done(1);
    });
    child.once("exit", (code, signal) => {
      gone = signal === null ? `it exited ${String(code ?? 0)}` : `it was stopped by ${signal}`;
      done(code ?? 1);
    });
  });
  return {
    stop: () => {
      const { pid } = child;
      if (gone !== undefined || pid === undefined) {
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
    gone: () => gone,
    ended,
  };
}

function stopListening(server: Server, graceMs: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => {
      clearTimeout(timer);
      done();
    });
    server.closeIdleConnections();
  });
}

function seconds(ms: number): string {
  return `${String(ms / 1000)}s`;
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface Waiting {
  ask: Ask;
  probeEveryMs: number;
  probeTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

async function answers(
  launch: Launch,
  port: number,
  version: string,
  waitMs: number,
  waiting: Waiting,
): Promise<string | undefined> {
  const deadline = waiting.now() + waitMs;
  let said: string | undefined;
  for (;;) {
    const gone = launch.gone();
    if (gone !== undefined) {
      return gone;
    }
    said = await waiting.ask(port, waiting.probeTimeoutMs);
    if (said === version) {
      return undefined;
    }
    if (waiting.now() >= deadline) {
      return said === undefined
        ? `it did not answer on port ${String(port)} within ${seconds(waitMs)}`
        : `port ${String(port)} answered as ${said}, not ${version}`;
    }
    await waiting.sleep(waiting.probeEveryMs);
  }
}

async function giveBack(
  server: Server,
  port: number,
  tries: number,
  waiting: Waiting,
): Promise<string | undefined> {
  let why = "nothing was tried";
  for (let i = 0; i < tries; i += 1) {
    try {
      await listen(server, port);
      return undefined;
    } catch (cause) {
      why = causeText(cause);
      await waiting.sleep(waiting.probeEveryMs);
    }
  }
  return why;
}

export function createRestarter(options: RestartOptions): Restarter {
  const { port, server } = options;
  const running = options.running ?? VERSION;
  const launch = options.launch ?? npxLaunch;
  const published = options.published ?? (() => readPublished());
  const scratch = options.scratchPort ?? scratchPort;
  const proveWaitMs = options.proveWaitMs ?? PROVE_WAIT_MS;
  const takeWaitMs = options.takeWaitMs ?? TAKE_WAIT_MS;
  const closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  const giveBackTries = options.giveBackTries ?? GIVE_BACK_TRIES;
  const log = options.log ?? ((line: string) => void process.stderr.write(`pitwall serve: ${line}\n`));
  const waiting: Waiting = {
    ask: options.ask ?? askVersion,
    probeEveryMs: options.probeEveryMs ?? PROBE_EVERY_MS,
    probeTimeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    sleep: options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms))),
    now: options.now ?? Date.now,
  };
  const refused = new Set<string>();
  let busy = false;
  let handed = false;

  const attempt = async (version: string): Promise<Handover> => {
    let scratched: number;
    try {
      scratched = await scratch();
    } catch (cause) {
      const why = `no unused port could be opened to prove it on: ${causeText(cause)}`;
      log(`${version} was not started - ${why}. ${running} keeps port ${String(port)}.`);
      return { kind: "unproven", version, why };
    }
    const proving = launch(version, scratched);
    const unproven = await answers(proving, scratched, version, proveWaitMs, waiting);
    if (unproven !== undefined) {
      proving.stop();
      refused.add(version);
      log(
        `Port ${String(port)} stays with ${running}: ${version} was not handed it because ${unproven}. The console keeps serving and keeps showing ${version} as available.`,
      );
      return { kind: "unproven", version, why: unproven };
    }
    log(
      `Port ${String(port)} goes to ${version}, which answered on port ${String(scratched)}. ${running} stops serving. A page loaded against snapshot contract ${SCHEMA_VERSION} is served by ${version} from here - across a major contract change that page can be sent a document shape its loaded script does not expect.`,
    );
    proving.stop();
    await stopListening(server, closeGraceMs);
    const serving = launch(version, port);
    const notTaken = await answers(serving, port, version, takeWaitMs, waiting);
    if (notTaken === undefined) {
      handed = true;
      return { kind: "handed-over", version, serving };
    }
    serving.stop();
    refused.add(version);
    await Promise.race([serving.ended, waiting.sleep(closeGraceMs)]);
    const stuck = await giveBack(server, port, giveBackTries, waiting);
    log(
      stuck === undefined
        ? `Port ${String(port)} is back with ${running}: ${version} did not take it because ${notTaken}. The console keeps showing ${version} as available.`
        : `Port ${String(port)} could not be taken back by ${running}: ${stuck}. ${version} did not take it either, because ${notTaken}. The console is serving nothing - start it again.`,
    );
    return { kind: "not-taken", version, why: notTaken };
  };

  return {
    consider: async (): Promise<Handover> => {
      if (busy || handed) {
        return { kind: "in-flight" };
      }
      busy = true;
      try {
        const version = await published();
        if (version === undefined || !newerThan(version, running)) {
          return { kind: "nothing-newer" };
        }
        if (refused.has(version)) {
          return { kind: "already-tried", version };
        }
        return await attempt(version);
      } finally {
        busy = false;
      }
    },
  };
}
