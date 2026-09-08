import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SCHEMA_VERSION, parseSnapshot } from "@404sl/pitwall-schema";
import { DEFAULT_PORT, HOST, createConsoleServer, listen, parseServeArgs } from "../src/serve.ts";
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

function trackerSnapshot(issues: Array<Record<string, unknown>>): string {
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
      },
    ],
  });
}

function trackerServer(bin: string, issues: Array<Record<string, unknown>>): Server {
  const { env } = stateWith(trackerSnapshot(issues));
  return createConsoleServer({
    env: { ...env, PATH: `${join(BD_FIXTURES, bin)}:/usr/bin:/bin` },
    uiDir: builtConsole(),
  });
}

test("one issue is served with its body, which the snapshot never carries", async (t) => {
  const server = trackerServer("ok", [indexed("mw-1", "open", "parked:umbrella")]);
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

test("an issue that is not there is a 404, told apart from one that could not be read", async (t) => {
  const readable = trackerServer("ok", [indexed("mw-1", "open", "parked:umbrella")]);
  const unreadable = trackerServer("failing", [indexed("mw-1", "open", "parked:umbrella")]);
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
  assert.ok(unread.tried.includes("bd statuses --json"));
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
