import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { DEFAULT_PORT } from "../src/serve.ts";
import { VERSION } from "../src/version.ts";
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";

test("--version reports the agent and the contract it speaks", () => {
  const { code, out } = run(["--version"]);
  assert.equal(code, 0);
  assert.match(out, new RegExp(`pitwall ${VERSION}`));
  assert.match(out, new RegExp(`contract ${SCHEMA_VERSION}`));
});

test("no arguments prints usage rather than failing", () => {
  assert.equal(run([]).code, 0);
});

test("an unknown argument exits non-zero and still shows usage", () => {
  const { code, out } = run(["--nope"]);
  assert.equal(code, 2);
  assert.match(out, /unknown argument --nope/);
  assert.match(out, /pitwall --help/);
});

test("serve defaults to a fixed port and takes --port", () => {
  assert.deepEqual(run(["serve"]).serve, { port: DEFAULT_PORT });
  assert.deepEqual(run(["serve", "--port", "9123"]).serve, { port: 9123 });
});

test("a port that is not a port exits non-zero and shows usage", () => {
  const { code, out, serve } = run(["serve", "--port", "nope"]);
  assert.equal(code, 2);
  assert.equal(serve, undefined);
  assert.match(out, /pitwall --help/);
});

test("usage names the serve command", () => {
  assert.match(run(["--help"]).out, new RegExp(`pitwall serve[\\s\\S]*${DEFAULT_PORT}`));
});

test("snapshot is a command of its own and takes no arguments", () => {
  const { code, out, snapshot } = run(["snapshot"]);
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.equal(snapshot, true);
});

test("an argument after snapshot exits non-zero and shows usage", () => {
  const { code, out, snapshot } = run(["snapshot", "--nope"]);
  assert.equal(code, 2);
  assert.equal(snapshot, undefined);
  assert.match(out, /unknown argument --nope/);
  assert.match(out, /pitwall --help/);
});

test("usage names the snapshot command", () => {
  assert.match(run(["--help"]).out, /pitwall snapshot/);
});

test("status is a command of its own and defaults to the state path", () => {
  const { code, out, status } = run(["status"]);
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.deepEqual(status, {});
});

test("status takes --from so a snapshot on disk can be read instead", () => {
  assert.deepEqual(run(["status", "--from", "/tmp/snap.json"]).status, { from: "/tmp/snap.json" });
});

test("a --from without a path exits non-zero and shows usage", () => {
  const { code, out, status } = run(["status", "--from"]);
  assert.equal(code, 2);
  assert.equal(status, undefined);
  assert.match(out, /--from expects a path/);
  assert.match(out, /pitwall --help/);
});

test("usage names the status command", () => {
  assert.match(run(["--help"]).out, /pitwall status/);
});

test("doctor is a command of its own and takes no arguments", () => {
  const { code, out, doctor } = run(["doctor"]);
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.equal(doctor, true);
});

test("an argument after doctor exits non-zero and shows usage", () => {
  const { code, out, doctor } = run(["doctor", "--nope"]);
  assert.equal(code, 2);
  assert.equal(doctor, undefined);
  assert.match(out, /unknown argument --nope/);
  assert.match(out, /pitwall --help/);
});

test("usage names the doctor command", () => {
  assert.match(run(["--help"]).out, /pitwall doctor/);
});

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

function snapshotFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "pitwall-cli-")), "snapshot.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-09-08T14:11:00Z",
      agent: { version: VERSION, executor: "local" },
      projects: [{ id: "p", name: "p", root: "/p", authority: { kind: "beads" }, metrics: {} }],
      errors: [],
    }),
  );
  return path;
}

function readerThatLeaves(argv: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("a reader that closes the pipe first leaves quietly rather than reporting EPIPE", async () => {
  const { code, stderr } = await readerThatLeaves(["status", "--from", snapshotFile()]);
  assert.doesNotMatch(stderr, /EPIPE/, stderr);
  assert.equal(code, 0);
});
