import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CollectionError } from "@404sl/pitwall-schema";
import { preconditionProbe } from "../src/probes.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NO_TOOLS = join(FIXTURES, "gh", "missing");
const UNAUTH_GH = `${join(FIXTURES, "gh", "unauth")}:/usr/bin:/bin`;

test("a precondition that could not be run at all is recorded once, not once per issue", async () => {
  const errors: CollectionError[] = [];
  const probe = preconditionProbe({ env: { PATH: NO_TOOLS }, errors });
  assert.equal(await probe(["npm", "whoami"]), undefined);
  assert.equal(await probe(["npm", "whoami"]), undefined);
  assert.equal(await probe(["npm", "whoami"]), undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.source, "npm whoami");
  assert.match(errors[0]?.message ?? "", /ENOENT/);
});

test("a precondition that runs and fails is an answer, not a collection error", async () => {
  const errors: CollectionError[] = [];
  const probe = preconditionProbe({ env: { PATH: UNAUTH_GH }, errors });
  assert.equal(await probe(["gh", "auth", "status"]), false);
  assert.deepEqual(errors, []);
});

test("a probe with nowhere to report still answers", async () => {
  const probe = preconditionProbe({ env: { PATH: NO_TOOLS } });
  assert.equal(await probe(["npm", "whoami"]), undefined);
});
