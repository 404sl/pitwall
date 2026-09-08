import { test } from "node:test";
import assert from "node:assert/strict";
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
