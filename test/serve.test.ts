import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createServer, request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SCHEMA_VERSION, parseSnapshot } from "@404sl/pitwall-schema";
import {
  ACTIONS,
  DEFAULT_PORT,
  HOST,
  NOTHING_READ,
  createConsoleServer,
  listen,
  parseServeArgs,
  sendIssueFailure,
  type Collection,
} from "../src/serve.ts";
import { REFRESH_SOURCE } from "../src/board.ts";
import { snapshotPath, stateHome } from "../src/state.ts";
import { VERSION } from "../src/version.ts";

const SNAPSHOT = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "2026-09-08T10:00:00Z",
  agent: { version: VERSION, executor: "local" },
  projects: [],
};

function stateWith(contents?: string): { env: Record<string, string | undefined>; path: string } {
  const home = mkdtempSync(join(tmpdir(), "pitwall-state-"));
  const path = join(home, "pitwall", "snapshot.json");
  if (contents !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return { env: { XDG_STATE_HOME: home }, path };
}

const OUTSIDE_THE_CONSOLE = "a file the console must never hand out\n";

function builtConsole(): string {
  const root = mkdtempSync(join(tmpdir(), "pitwall-ui-"));
  const dir = join(root, "ui");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Pitwall</title>");
  writeFileSync(join(dir, "assets", "console.js"), "export const built = true;\n");
  writeFileSync(join(root, "outside.txt"), OUTSIDE_THE_CONSOLE);
  return dir;
}

function withHost(origin: string, path: string, host: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(origin);
  return new Promise((done, failed) => {
    const call = request({ host: hostname, port, path, headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => done({ status: response.statusCode ?? 0, body }));
    });
    call.on("error", failed);
    call.end();
  });
}

async function started(server: Server): Promise<{ origin: string; port: number }> {
  await listen(server, 0);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://${HOST}:${port}`, port };
}

function externalAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

function refused(host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.on("connect", () => {
      socket.destroy();
      done("connected");
    });
    socket.on("timeout", () => {
      socket.destroy();
      done("unreachable");
    });
    socket.on("error", () => done("unreachable"));
  });
}

test("the state path is the XDG one, and honours XDG_STATE_HOME", () => {
  assert.equal(
    snapshotPath({ env: {}, home: "/home/nobody" }),
    join("/home/nobody", ".local", "state", "pitwall", "snapshot.json"),
  );
  assert.equal(stateHome({ env: { XDG_STATE_HOME: "" }, home: "/home/nobody" }), join("/home/nobody", ".local", "state"));
  assert.equal(
    snapshotPath({ env: { XDG_STATE_HOME: "/var/state" }, home: "/home/nobody" }),
    join("/var/state", "pitwall", "snapshot.json"),
  );
});

test("the snapshot endpoint serves what is stored", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/snapshot`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), parseSnapshot(SNAPSHOT));
});

test("the version endpoint names the running process, not the process that wrote the snapshot", async (t) => {
  const { env } = stateWith(JSON.stringify({ ...SNAPSHOT, agent: { version: "0.0.1", executor: "local" } }));
  const server = createConsoleServer({
    env,
    uiDir: builtConsole(),
    updates: { update: () => undefined, refresh: () => Promise.resolve() },
  });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/version`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, string>;
  assert.equal(body.running, VERSION);
  assert.equal("update" in body, false);
});

test("the version endpoint carries the newer release once a check has confirmed one", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({
    env,
    uiDir: builtConsole(),
    updates: { update: () => "9.9.9", refresh: () => Promise.resolve() },
  });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/version`);
  assert.deepEqual(await response.json(), { running: VERSION, update: "9.9.9" });
});

test("the snapshot endpoint keeps its shape - the version is served beside it, never inside it", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({
    env,
    uiDir: builtConsole(),
    updates: { update: () => "9.9.9", refresh: () => Promise.resolve() },
  });
  t.after(() => server.close());
  const { origin } = await started(server);

  const body = (await (await fetch(`${origin}/api/snapshot`)).json()) as Record<string, unknown>;
  assert.deepEqual(body, parseSnapshot(SNAPSHOT));
  assert.equal("update" in body, false);
});

test("no snapshot is a 503 that says so, never an empty document", async (t) => {
  const { env, path } = stateWith();
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/snapshot`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { message: string; source: string };
  assert.match(body.message, /No snapshot/);
  assert.equal(body.source, path);
  assert.equal("projects" in body, false);
});

test("a snapshot that cannot be parsed is a 503, not an empty one", async (t) => {
  const { env } = stateWith('{ "schemaVersion": "1.1.0"');
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/snapshot`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { message: string };
  assert.match(body.message, /could not be read/);
});

test("a snapshot that does not meet the contract is a 503 as well", async (t) => {
  const { env } = stateWith(JSON.stringify({ schemaVersion: "1.1.0", projects: [] }));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 503);
});

test("the root serves the built console and its assets", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /Pitwall/);

  const asset = await fetch(`${origin}/assets/console.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
});

test("an unbuilt console is a 503 naming what builds it, and a stray path is a 404", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: join(tmpdir(), "pitwall-never-built") });
  t.after(() => server.close());
  const { origin } = await started(server);

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /build:ui/);

  const built = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => built.close());
  const other = await started(built);
  assert.equal((await fetch(`${other.origin}/nope.js`)).status, 404);
});

test("a path that climbs out of the built console is a 404, and hands nothing over", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  const climbed = await fetch(`${origin}/..%2foutside.txt`);
  assert.equal(climbed.status, 404);
  assert.equal((await climbed.text()).includes(OUTSIDE_THE_CONSOLE), false);
});

test("a file that cannot be read is an error, and leaves the server answering", { skip: process.getuid?.() === 0 }, async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const uiDir = builtConsole();
  chmodSync(join(uiDir, "assets", "console.js"), 0o000);
  const server = createConsoleServer({ env, uiDir });
  t.after(() => server.close());
  const { origin } = await started(server);

  const locked = await fetch(`${origin}/assets/console.js`);
  assert.equal(locked.status, 500);
  assert.equal(server.listening, true);
  assert.equal((await fetch(`${origin}/`)).status, 200);
});

test("a request addressed to somewhere other than localhost is refused", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  const rebound = await withHost(origin, "/api/snapshot", "console.example.com");
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.includes("projects"), false);

  const named = await withHost(origin, "/api/snapshot", `localhost:${new URL(origin).port}`);
  assert.equal(named.status, 200);
});

test("the server binds to localhost and is not reachable from the network", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { port } = await started(server);

  assert.equal((server.address() as AddressInfo).address, HOST);
  assert.equal(await refused(HOST, port), "connected");

  const outside = externalAddress();
  if (outside !== undefined) {
    assert.equal(await refused(outside, port), "unreachable");
  }
});

test("--port is honoured and the default is fixed", () => {
  assert.deepEqual(parseServeArgs([]), { port: DEFAULT_PORT });
  assert.deepEqual(parseServeArgs(["--port", "9123"]), { port: 9123 });
  assert.deepEqual(parseServeArgs(["--port=9123"]), { port: 9123 });
  assert.match((parseServeArgs(["--port", "nope"]) as { error: string }).error, /--port/);
  assert.match((parseServeArgs(["--port", "70000"]) as { error: string }).error, /--port/);
  assert.match((parseServeArgs(["--port"]) as { error: string }).error, /nothing/);
  assert.match((parseServeArgs(["--host", "0.0.0.0"]) as { error: string }).error, /unknown argument/);
});

const BD_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd");
const TRACKER = join(BD_FIXTURES, "tracker");

function indexed(
  id: string,
  status: string,
  classification: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, title: `title for ${id}`, status, classification, ...extra };
}

function trackerSnapshot(
  issues: Array<Record<string, unknown>>,
  errors: Array<Record<string, unknown>> = [],
): string {
  return JSON.stringify({
    ...SNAPSHOT,
    projects: [
      {
        id: "mw",
        name: "milliwatt",
        root: TRACKER,
        authority: { kind: "beads", idPrefix: "mw" },
        metrics: {},
        issues,
        errors,
      },
    ],
  });
}

function trackerServer(
  bin: string,
  issues: Array<Record<string, unknown>>,
  errors: Array<Record<string, unknown>> = [],
  extra: Record<string, string> = {},
): Server {
  const { env } = stateWith(trackerSnapshot(issues, errors));
  return createConsoleServer({
    env: { ...env, PATH: `${join(BD_FIXTURES, bin)}:/usr/bin:/bin`, ...extra },
    uiDir: builtConsole(),
  });
}

test("one issue is served with its body, which the snapshot never carries", async (t) => {
  const server = trackerServer("ok", [
    indexed("mw-1", "open", "parked:umbrella"),
    indexed("mw-1.1", "open", "ready"),
  ]);
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/issue/mw/mw-1`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    issue: { description: string; notes: string; classification: string; reason: { rule: string } };
    readAt: string;
    snapshot: { generatedAt: string; status: string };
  };
  assert.match(body.issue.description, /The screen this product exists to show/);
  assert.match(body.issue.notes, /Signal colours never decorate/);
  assert.equal(body.issue.classification, "parked:umbrella");
  assert.equal(body.issue.reason.rule, "umbrella-open-child");
  assert.ok(Date.parse(body.readAt) > 0);
  assert.equal(body.snapshot.status, "open");

  const document = await (await fetch(`${origin}/api/snapshot`)).text();
  assert.equal(document.includes("The screen this product exists to show"), false);
  assert.equal(document.includes("\"description\""), false);
  assert.equal(document.includes("\"notes\""), false);
});

test("opening one ticket costs one call to the tracker, not a reading of the whole board", async (t) => {
  const log = join(mkdtempSync(join(tmpdir(), "pitwall-calls-")), "bd.log");
  const server = trackerServer(
    "ok",
    [indexed("mw-1", "open", "parked:umbrella"), indexed("mw-1.1", "open", "ready")],
    [],
    { BD_CALL_LOG: log },
  );
  t.after(() => server.close());
  const { origin } = await started(server);

  assert.equal((await fetch(`${origin}/api/issue/mw/mw-1`)).status, 200);
  const ran = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  assert.deepEqual(ran, ["show --id mw-1 --json --include-dependents"]);
});

test("an issue that is not there is a 404, told apart from one that could not be read", async (t) => {
  const readable = trackerServer("ok", [indexed("mw-1", "open", "parked:umbrella")]);
  const unreadable = trackerServer("failing", [indexed("mw-1", "open", "parked:umbrella")]);
  const shown = "bd show --id mw-1 --json --include-dependents";
  t.after(() => {
    readable.close();
    unreadable.close();
  });

  const absent = await fetch(`${(await started(readable)).origin}/api/issue/mw/mw-nope`);
  assert.equal(absent.status, 404);
  const missing = (await absent.json()) as { message: string; project: string; id: string; tried?: unknown };
  assert.equal(missing.project, "milliwatt");
  assert.equal(missing.id, "mw-nope");
  assert.equal(missing.tried, undefined);

  const failed = await fetch(`${(await started(unreadable)).origin}/api/issue/mw/mw-1`);
  assert.equal(failed.status, 503);
  const unread = (await failed.json()) as { message: string; source: string; tried: string[] };
  assert.match(unread.message, /mw-1 could not be read/);
  assert.ok(unread.tried.includes(shown));
  assert.ok(unread.tried.some((entry) => entry.endsWith(".beads")));
});

test("an issue closed since the snapshot reports both the reading and the snapshot", async (t) => {
  const server = trackerServer("ok", [indexed("mw-9", "open", "ready")]);
  t.after(() => server.close());
  const { origin } = await started(server);

  const body = (await (await fetch(`${origin}/api/issue/mw/mw-9`)).json()) as {
    issue: { status: string; classification?: string; reason: { rule: string } };
    snapshot: { status: string; generatedAt: string };
  };
  assert.equal(body.issue.status, "closed");
  assert.equal(body.snapshot.status, "open");
  assert.equal(body.snapshot.generatedAt, SNAPSHOT.generatedAt);
  assert.equal(body.issue.classification, undefined, "closed work carries no active classification");
  assert.deepEqual(body.issue.reason, { rule: "closed" });
});

test("a verdict the snapshot checked survives a reading that has since closed", async (t) => {
  const server = trackerServer("ok", [
    indexed("mw-9", "open", "ready", {
      staleness: {
        verdict: "still-blocking",
        checkedAt: "2026-09-08T13:02:00Z",
        evidence: ["mw-1 is still open"],
      },
    }),
  ]);
  t.after(() => server.close());
  const { origin } = await started(server);

  const body = (await (await fetch(`${origin}/api/issue/mw/mw-9`)).json()) as {
    issue: { status: string; classification?: string; staleness: { verdict: string; checkedAt?: string; evidence: string[] } };
    snapshot: { status: string };
  };
  assert.equal(body.issue.status, "closed");
  assert.equal(body.snapshot.status, "open");
  assert.equal(body.issue.classification, undefined);
  assert.equal(body.issue.staleness.verdict, "still-blocking");
  assert.equal(body.issue.staleness.checkedAt, "2026-09-08T13:02:00Z");
  assert.deepEqual(body.issue.staleness.evidence, ["mw-1 is still open"]);
});

test("an issue carries the references its own check could not resolve, and nobody else's", async (t) => {
  const at = "2026-09-08T13:02:00Z";
  const server = trackerServer(
    "ok",
    [indexed("mw-1", "open", "parked:umbrella")],
    [
      { source: "staleness mw-1", message: "2 references could not be checked: ext#144, ext#148", at },
      { source: "staleness mw-9", message: "1 reference could not be checked: ext#150", at },
      { source: "staleness", message: "no pull request host is configured, so pull requests could not be looked up", at },
      { source: "bd list", message: "timed out", at },
    ],
  );
  t.after(() => server.close());
  const { origin } = await started(server);

  const body = (await (await fetch(`${origin}/api/issue/mw/mw-1`)).json()) as {
    errors: Array<{ source: string; message: string }>;
  };
  assert.deepEqual(body.errors, [
    { source: "staleness mw-1", message: "2 references could not be checked: ext#144, ext#148", at },
  ]);
});

test("an issue whose check resolved everything carries no errors at all", async (t) => {
  const server = trackerServer("ok", [indexed("mw-1", "open", "parked:umbrella")]);
  t.after(() => server.close());
  const { origin } = await started(server);

  const body = (await (await fetch(`${origin}/api/issue/mw/mw-1`)).json()) as {
    errors: Array<{ source: string }>;
  };
  assert.deepEqual(body.errors, []);
});

test("an issue the snapshot never indexed is served without a snapshot to compare against", async (t) => {
  const server = trackerServer("ok", []);
  t.after(() => server.close());
  const { origin } = await started(server);

  const body = (await (await fetch(`${origin}/api/issue/mw/mw-10`)).json()) as {
    issue: { classification: string; reason: { rule: string; status?: string }; staleness: { verdict: string } };
    snapshot?: unknown;
  };
  assert.equal(body.snapshot, undefined);
  assert.equal(body.issue.classification, "parked:roadmap");
  assert.deepEqual(body.issue.reason, { rule: "stored-status", status: "deferred" });
  assert.equal(body.issue.staleness.verdict, "unchecked");
});

test("the verdict one ticket reports agrees with the blocker status beside it", async (t) => {
  const unread = { source: join(TRACKER, ".beads"), message: "bd list --all --limit 0 --json: timed out", at: "2026-09-08T13:02:00Z" };
  const blind = trackerServer("ok", [], [unread]);
  const stale = trackerServer("ok", [indexed("mw-1", "open", "ready"), indexed("mw-9", "open", "ready")]);
  t.after(() => {
    blind.close();
    stale.close();
  });

  const blocked = (await (await fetch(`${(await started(blind)).origin}/api/issue/mw/mw-6`)).json()) as {
    issue: {
      classification: string;
      reason: { rule: string; ids?: string[] };
      blockedBy: Array<{ id: string; status: string }>;
    };
  };
  assert.deepEqual(
    blocked.issue.blockedBy.map((link) => [link.id, link.status]),
    [["mw-9", "open"]],
  );
  assert.equal(blocked.issue.classification, "blocked");
  assert.deepEqual(
    blocked.issue.reason,
    { rule: "blocked-open", ids: ["mw-9"] },
    "a board that could not be collected must not turn an open blocker into a guess",
  );

  const ready = (await (await fetch(`${(await started(stale)).origin}/api/issue/mw/mw-1`)).json()) as {
    issue: { classification: string; blockedBy: Array<{ id: string; status: string }> };
  };
  assert.deepEqual(
    ready.issue.blockedBy.map((link) => [link.id, link.status]),
    [["mw-9", "closed"]],
  );
  assert.equal(
    ready.issue.classification,
    "ready",
    "a snapshot still carrying mw-9 as open must not park a ticket the tracker has unblocked",
  );
});

test("a project the snapshot does not name is a read failure, not a missing issue", async (t) => {
  const server = trackerServer("ok", [indexed("mw-1", "open", "parked:umbrella")]);
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}/api/issue/nowhere/mw-1`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { message: string; tried: string[] };
  assert.match(body.message, /names no project nowhere/);
  assert.ok(body.tried.length > 0);
});

test("an issue path that is not a project and an id is not found", async (t) => {
  const server = trackerServer("ok", [indexed("mw-1", "open", "parked:umbrella")]);
  t.after(() => server.close());
  const { origin } = await started(server);

  assert.equal((await fetch(`${origin}/api/issue/mw`)).status, 404);
  assert.equal((await fetch(`${origin}/api/issue/mw/mw-1/extra`)).status, 404);
});

const LATE_ROUTE = { project: "mw", id: "mw-1" };
const LATE_PATH = "/api/issue/mw/mw-1";

test("an issue that fails before anything is written is a 503 naming what was tried", async (t) => {
  const server = createServer((_request, res) => {
    sendIssueFailure(res, LATE_PATH, LATE_ROUTE, new Error("the tracker went away"));
  });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}${LATE_PATH}`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { message: string; source: string; tried: string[] };
  assert.equal(body.message, "mw-1 could not be read: the tracker went away");
  assert.deepEqual(body.tried, [LATE_PATH]);
});

test("an issue that fails after its response has gone out is logged, never written twice", async (t) => {
  const logged: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    logged.push(chunk.toString());
    return true;
  });
  let threw: unknown;
  const server = createServer((_request, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ issue: { id: "mw-1" } }));
    try {
      sendIssueFailure(res, LATE_PATH, LATE_ROUTE, new Error("read after the body"));
    } catch (cause) {
      threw = cause;
    }
  });
  t.after(() => server.close());
  const { origin } = await started(server);

  const response = await fetch(`${origin}${LATE_PATH}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { issue: { id: "mw-1" } });
  assert.equal(threw, undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0] as string, /mw-1 could not be read: read after the body/);
});

function settle(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

const READ: Collection = { read: true, errors: [] };
const READ_NOTHING: Collection = { read: false, errors: [] };

function deferred(): { promise: Promise<Collection>; resolve: (answer: Collection) => void } {
  let resolve!: (answer: Collection) => void;
  const promise = new Promise<Collection>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function collector(answers: Array<() => Promise<Collection>>): {
  collect: () => Promise<Collection>;
  calls: Array<Promise<Collection>>;
} {
  const calls: Array<Promise<Collection>> = [];
  const collect = () => {
    const answer = answers[Math.min(calls.length, answers.length - 1)] as () => Promise<Collection>;
    const running = answer();
    calls.push(running);
    return running;
  };
  return { collect, calls };
}

function errorsOf(body: unknown): Array<{ source: string; message: string; at: string }> {
  return (body as { errors?: Array<{ source: string; message: string; at: string }> }).errors ?? [];
}

test("a snapshot older than the floor is served at once and re-collected behind it, once", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const stalled = deferred();
  const { collect, calls } = collector([() => stalled.promise]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  const first = await fetch(`${origin}/api/snapshot`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), parseSnapshot(SNAPSHOT));
  assert.equal(calls.length, 1);

  const second = await fetch(`${origin}/api/snapshot`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), parseSnapshot(SNAPSHOT));
  assert.equal(calls.length, 1);

  stalled.resolve(READ);
  await settle();
});

test("a snapshot inside the floor is served without collecting anything", async (t) => {
  const { env } = stateWith(JSON.stringify({ ...SNAPSHOT, generatedAt: new Date().toISOString() }));
  const { collect, calls } = collector([() => Promise.resolve(READ)]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 200);
  await settle();
  assert.equal(calls.length, 0);
});

test("a re-collection that fails keeps the stored snapshot and says the refresh failed", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const { collect, calls } = collector([() => Promise.reject(new Error("bd is not on PATH"))]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>).catch(() => undefined);
  await settle();

  const response = await fetch(`${origin}/api/snapshot`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual((body as { projects: unknown }).projects, parseSnapshot(SNAPSHOT).projects);
  assert.equal((body as { generatedAt: string }).generatedAt, parseSnapshot(SNAPSHOT).generatedAt);
  const errors = errorsOf(body);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, REFRESH_SOURCE);
  assert.match(errors[0]?.message ?? "", /bd is not on PATH/);
  assert.equal(calls.length, 1);
});

test("a re-collection that reads no project is a failed refresh, not a fresh board", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const { collect, calls } = collector([() => Promise.resolve(READ_NOTHING)]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>);
  await settle();

  const errors = errorsOf(await (await fetch(`${origin}/api/snapshot`)).json());
  assert.equal(errors[0]?.source, REFRESH_SOURCE);
  assert.equal(errors[0]?.message, NOTHING_READ);
});

test("a re-collection that read nothing names the source that could not be read", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const { collect, calls } = collector([
    () =>
      Promise.resolve({
        read: false,
        errors: [{ source: "bd list", message: "bd: command not found", at: SNAPSHOT.generatedAt }],
      }),
  ]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>);
  await settle();

  const errors = errorsOf(await (await fetch(`${origin}/api/snapshot`)).json());
  assert.equal(errors[0]?.message, `${NOTHING_READ} bd list: bd: command not found`);
});

test("a collector that throws where it stands leaves the console able to try again", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  let calls = 0;
  const collect = () => {
    calls += 1;
    throw new Error("spawn EAGAIN");
  };
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect, refreshFloorMs: 0 });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await settle();
  const errors = errorsOf(await (await fetch(`${origin}/api/snapshot`)).json());
  assert.equal(errors[0]?.source, REFRESH_SOURCE);
  assert.match(errors[0]?.message ?? "", /spawn EAGAIN/);
  await settle();
  assert.equal(calls, 2);
});

test("a re-collection that succeeds clears the failure the last one left", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const { collect, calls } = collector([
    () => Promise.reject(new Error("bd is not on PATH")),
    () => Promise.resolve(READ),
  ]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect, refreshFloorMs: 0 });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>).catch(() => undefined);
  await settle();
  assert.equal(errorsOf(await (await fetch(`${origin}/api/snapshot`)).json()).length, 1);

  await (calls[1] as Promise<Collection>);
  await settle();
  assert.deepEqual(await (await fetch(`${origin}/api/snapshot`)).json(), parseSnapshot(SNAPSHOT));
});

test("nothing stored is still a 503, and still starts the collection that would fix it", async (t) => {
  const { env } = stateWith();
  const { collect, calls } = collector([() => Promise.resolve(READ)]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 503);
  await settle();
  assert.equal(calls.length, 1);
});

test("a console with no collector never re-collects, whatever the age of what it serves", async (t) => {
  const { env } = stateWith(JSON.stringify(SNAPSHOT));
  const server = createConsoleServer({ env, uiDir: builtConsole() });
  t.after(() => server.close());
  const { origin } = await started(server);

  assert.deepEqual(await (await fetch(`${origin}/api/snapshot`)).json(), parseSnapshot(SNAPSHOT));
});

test("a 503 with a failed collection behind it says why the collection failed too", async (t) => {
  const { env } = stateWith();
  const { collect, calls } = collector([() => Promise.reject(new Error("bd is not on PATH"))]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>).catch(() => undefined);
  await settle();

  const response = await fetch(`${origin}/api/snapshot`);
  assert.equal(response.status, 503);
  const { message } = (await response.json()) as { message: string };
  assert.match(message, /No snapshot to show yet/);
  assert.match(message, /The last collection failed too: bd is not on PATH/);
});

test("a 503 with a collection that read nothing never claims a board is still showing", async (t) => {
  const { env } = stateWith();
  const { collect, calls } = collector([
    () =>
      Promise.resolve({
        read: false,
        errors: [
          { source: "/x/.beads: bd statuses --json", message: "spawn bd ENOENT", at: SNAPSHOT.generatedAt },
        ],
      }),
  ]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>);
  await settle();

  const response = await fetch(`${origin}/api/snapshot`);
  assert.equal(response.status, 503);
  const { message } = (await response.json()) as { message: string };
  assert.match(message, /No snapshot to show yet/);
  assert.match(
    message,
    /The last collection could read no project either: \/x\/\.beads: bd statuses --json: spawn bd ENOENT/,
  );
  assert.doesNotMatch(message, /still shows the last snapshot/);
});

test("a 503 with a collection that read nothing and named no cause still reads as one sentence", async (t) => {
  const { env } = stateWith();
  const { collect, calls } = collector([() => Promise.resolve(READ_NOTHING)]);
  const server = createConsoleServer({ env, uiDir: builtConsole(), collect });
  t.after(() => server.close());
  const { origin } = await started(server);

  await fetch(`${origin}/api/snapshot`);
  await (calls[0] as Promise<Collection>);
  await settle();

  const { message } = (await (await fetch(`${origin}/api/snapshot`)).json()) as { message: string };
  assert.match(message, /The last collection could read no project either\.$/);
  assert.doesNotMatch(message, /still shows the last snapshot/);
});

interface Sent {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function call(
  origin: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  payload = "",
): Promise<Sent> {
  const { hostname, port } = new URL(origin);
  return new Promise((done, failed) => {
    const sending = request(
      {
        host: hostname,
        port,
        path,
        method,
        headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          done({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    sending.on("error", failed);
    sending.end(payload);
  });
}

interface ActionBox {
  server: Server;
  origin: string;
  log: string;
  notes: string;
  post: (path: string, options?: { text?: string; headers?: Record<string, string>; bare?: boolean }) => Promise<Sent>;
}

const ACTING_HOST = "127.0.0.1";

async function acting(
  closing: { after: (teardown: () => void) => void },
  issues: Array<Record<string, unknown>> = [indexed("mw-3", "open", "yours:decision")],
  extra: Record<string, string> = {},
): Promise<ActionBox> {
  const room = mkdtempSync(join(tmpdir(), "pitwall-acting-"));
  const log = join(room, "calls.log");
  const notes = join(room, "notes.log");
  const server = trackerServer("ok", issues, [], { BD_CALL_LOG: log, BD_NOTES_LOG: notes, ...extra });
  closing.after(() => server.close());
  const { origin, port } = await started(server);
  const host = `${ACTING_HOST}:${String(port)}`;
  return {
    server,
    origin,
    log,
    notes,
    post: (path, options = {}) =>
      call(
        origin,
        path,
        "POST",
        {
          host,
          "content-type": "application/json",
          ...(options.bare === true ? {} : { "x-pitwall-action": "1" }),
          ...options.headers,
        },
        options.text === undefined ? "" : JSON.stringify({ text: options.text }),
      ),
  };
}

function logged(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

function writtenTo(path: string): string[] {
  return logged(path).filter(
    (line) => line.includes("--append-notes") || line.includes("--remove-label"),
  );
}

test("a console action with no action header is refused, and the tracker is never touched", async (t) => {
  const box = await acting(t);
  const refusedAction = await box.post("/api/issue/mw/mw-3/ready", { bare: true });

  assert.equal(refusedAction.status, 403);
  assert.match(refusedAction.body, /x-pitwall-action/);
  assert.deepEqual(
    logged(box.log),
    [],
    "the header gate let a request reach bd, so a cross-origin page could write",
  );
});

test("a write claiming another origin, or one the browser calls cross-site, is refused", async (t) => {
  const box = await acting(t);
  const foreign = await box.post("/api/issue/mw/mw-3/ready", {
    headers: { origin: "http://pitwall.build.evil.example" },
  });
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /pitwall\.build\.evil\.example/);

  const opaque = await box.post("/api/issue/mw/mw-3/ready", { headers: { origin: "null" } });
  assert.equal(opaque.status, 403);

  const crossSite = await box.post("/api/issue/mw/mw-3/ready", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(writtenTo(box.log), [], "a refused action still wrote to the tracker");

  const own = await box.post("/api/issue/mw/mw-3/ready", {
    headers: { origin: box.origin, "sec-fetch-site": "same-origin" },
  });
  assert.equal(own.status, 200, own.body);
});

test("the preflight a cross-origin write would need is answered by nothing", async (t) => {
  const box = await acting(t);
  const asked = await call(box.origin, "/api/issue/mw/mw-3/ready", "OPTIONS", {
    host: ACTING_HOST,
    origin: "http://pitwall.build.evil.example",
    "access-control-request-method": "POST",
    "access-control-request-headers": "x-pitwall-action",
  });

  assert.equal(asked.headers["access-control-allow-origin"], undefined);
  assert.equal(asked.headers["access-control-allow-headers"], undefined);
  assert.deepEqual(writtenTo(box.log), []);
});

test("an answer lands on the ticket before the labels that park it are cleared", async (t) => {
  const box = await acting(t);
  const answered = await box.post("/api/issue/mw/mw-3/answer", {
    text: "credit the account, and record the amount on the ticket",
  });

  assert.equal(answered.status, 200, answered.body);
  assert.match(
    readFileSync(box.notes, "utf8"),
    /mw-3 Answered from the console: credit the account, and record the amount on the ticket/,
  );
  const writes = writtenTo(box.log);
  assert.equal(writes.length, 2);
  assert.match(writes[0] ?? "", /--append-notes/);
  assert.match(
    writes[1] ?? "",
    /^update mw-3 --remove-label needs-decision --remove-label needs-access$/,
    "the labels were cleared before the answer was on the ticket, so a lane could run without it",
  );
});

test("marking it ready clears both labels and says the console did it", async (t) => {
  const box = await acting(t);
  const ready = await box.post("/api/issue/mw/mw-3/ready");

  assert.equal(ready.status, 200, ready.body);
  assert.match(readFileSync(box.notes, "utf8"), /mw-3 Marked ready from the console\./);
  assert.deepEqual((JSON.parse(ready.body) as { removedLabels: string[] }).removedLabels, [
    "needs-decision",
    "needs-access",
  ]);
});

test("pushing an issue off the owner's queue records the classification it is correcting", async (t) => {
  const box = await acting(t);
  const returned = await box.post("/api/issue/mw/mw-3/not-mine", {
    text: "any engineer can pick the refund path",
  });

  assert.equal(returned.status, 200, returned.body);
  assert.match(
    readFileSync(box.notes, "utf8"),
    /mw-3 Not mine — the console classified this yours:decision\. Reason: any engineer can pick the refund path/,
  );
});

test("an empty box cannot unpark an issue", async (t) => {
  const box = await acting(t);
  const blank = await box.post("/api/issue/mw/mw-3/answer", { text: "   " });
  assert.equal(blank.status, 400);
  assert.match(blank.body, /mw-3 was not changed/);

  const unsaid = await box.post("/api/issue/mw/mw-3/not-mine", { text: "" });
  assert.equal(unsaid.status, 400);
  assert.deepEqual(writtenTo(box.log), []);
});

test("the console does not act on an issue it no longer classifies", async (t) => {
  const box = await acting(t, [indexed("mw-9", "closed", "ready")]);
  const closed = await box.post("/api/issue/mw/mw-9/ready");

  assert.equal(closed.status, 400);
  assert.match(closed.body, /acts on open work only/);
  assert.deepEqual(writtenTo(box.log), []);
});

test("an action on an issue the tracker has never heard of is a 404", async (t) => {
  const box = await acting(t);
  const missing = await box.post("/api/issue/mw/mw-404/ready");

  assert.equal(missing.status, 404);
  assert.match(missing.body, /milliwatt has no issue mw-404/);
  assert.deepEqual(writtenTo(box.log), []);
});

test("an unknown action is a 404 that names the actions that exist", async (t) => {
  const box = await acting(t);
  const merged = await box.post("/api/issue/mw/mw-3/merge");

  assert.equal(merged.status, 404);
  for (const action of ACTIONS) {
    assert.match(merged.body, new RegExp(action));
  }
  assert.deepEqual(writtenTo(box.log), []);
});

test("a write that got the note on but not the labels off says so, rather than 'nothing changed'", async (t) => {
  const box = await acting(t, undefined, { BD_LABELS_FAIL: "label needs-decision is not set" });
  const tried = await box.post("/api/issue/mw/mw-3/ready");

  assert.equal(tried.status, 502);
  assert.match(readFileSync(box.notes, "utf8"), /mw-3 Marked ready from the console\./);
  assert.match(tried.body, /mw-3 carries the note but is still parked/);
  assert.match(tried.body, /--remove-label/);
  assert.doesNotMatch(
    tried.body,
    /was not changed/,
    "the note is already on the ticket, and a re-submit would put a second one there",
  );
});

test("a note that will not write stops the action, so no issue is unparked without it", async (t) => {
  const box = await acting(t, undefined, { BD_NOTES_LOG: "" });
  const tried = await box.post("/api/issue/mw/mw-3/answer", { text: "credit the account" });

  assert.equal(tried.status, 502);
  assert.match(tried.body, /mw-3 was not changed/);
  assert.deepEqual(
    logged(box.log).filter((line) => line.includes("--remove-label")),
    [],
    "the labels were cleared after the note failed, so a lane can take work whose answer was lost",
  );
});
