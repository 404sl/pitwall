import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function builtConsole(): string {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-ui-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Pitwall</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "console.js"), "export const built = true;\n");
  return dir;
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
  assert.equal((await fetch(`${other.origin}/%2e%2e/%2e%2e/etc/hosts`)).status, 404);
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
