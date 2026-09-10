import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Origin } from "@404sl/pitwall-schema";
import type { Notice } from "../src/notify.ts";
import {
  SESSION_REF_FIELD,
  SESSION_REF_VAR,
  commandSender,
  sessionRefOf,
  workspaceSender,
} from "../src/sender.ts";

const ASKED: Origin = { session: "dev-loop", ref: "c1796a" };

const NOTICE: Notice = {
  issueId: "mw-1",
  title: "mw-1 title",
  origin: ASKED,
  pull: undefined,
  text: "mw-1 closed: mw-1 title. Closed by site#31.",
};

function root(workspace: Record<string, unknown> | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-sender-"));
  if (workspace !== undefined) {
    writeFileSync(join(dir, ".pitwall.json"), JSON.stringify(workspace));
  }
  return dir;
}

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pitwall-notifier-"));
  const path = join(dir, "notify.mjs");
  writeFileSync(path, body);
  return path;
}

test("a configured command is handed the notice as JSON on its standard input", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "pitwall-notice-")), "notice.json");
  const path = script(
    `import { readFileSync, writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(log)}, readFileSync(0, "utf8"));`,
  );
  const delivery = await commandSender([execPath, path])(NOTICE);
  assert.deepEqual(delivery, { delivered: true });
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), {
    issueId: "mw-1",
    title: "mw-1 title",
    origin: { session: "dev-loop", ref: "c1796a" },
    text: "mw-1 closed: mw-1 title. Closed by site#31.",
  });
});

test("a command that cannot be run comes back as a reason rather than throwing", async () => {
  const delivery = await commandSender([join(root(undefined), "no-such-notifier")])(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /could not be run: spawn .*ENOENT/);
});

test("a ref that no longer resolves is undelivered, carrying what the command said", async () => {
  const path = script(
    `process.stderr.write("no session c1796a is alive\\n");
     process.exit(3);`,
  );
  const delivery = await commandSender([execPath, path])(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /exited 3: no session c1796a is alive/);
});

test("a command that exits before reading the notice is a reason, not a broken pipe", async () => {
  const path = script(`process.exit(4);`);
  const delivery = await commandSender([execPath, path])(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /exited 4 and said nothing/);
});

test("a command that never answers is given up on", async () => {
  const path = script(`setTimeout(() => process.exit(0), 60_000);`);
  const delivery = await commandSender([execPath, path], { timeoutMs: 250 })(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /did not answer within 250ms/);
});

test(`${SESSION_REF_VAR} names the collecting session, the workspace file is the fallback`, () => {
  const configured = root({ [SESSION_REF_FIELD]: "from-file" });
  assert.equal(sessionRefOf(configured, { env: {} }), "from-file");
  assert.equal(sessionRefOf(configured, { env: { [SESSION_REF_VAR]: "from-env" } }), "from-env");
  assert.equal(sessionRefOf(configured, { env: { [SESSION_REF_VAR]: "" } }), "from-file");
  assert.equal(sessionRefOf(root({}), { env: {} }), undefined);
  assert.equal(sessionRefOf(root(undefined), { env: {} }), undefined);
});

test("with no ref for the collecting session every notice is held and says why", async () => {
  const dir = root({ notify: ["true"] });
  const delivery = await workspaceSender(dir, { env: {} })(NOTICE);
  assert.equal(delivery.delivered, false);
  const reason = delivery.delivered ? "" : delivery.reason;
  assert.match(reason, new RegExp(`${SESSION_REF_VAR} is not set`));
  assert.match(reason, /cannot tell its own work from another session's/);
});

test("a workspace that configures no command holds its notices and names the field", async () => {
  const dir = root({ idPrefix: "mw" });
  const delivery = await workspaceSender(dir, { env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /no notify command is configured/);
});

test("a notify field that is not a command is refused with a reason", async () => {
  const dir = root({ notify: "say-something" });
  const delivery = await workspaceSender(dir, { env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /is not a command/);
});

test("a configured notifier runs from the workspace root so a relative path resolves", async () => {
  const dir = root(undefined);
  mkdirSync(join(dir, "script"), { recursive: true });
  const log = join(dir, "delivered.json");
  writeFileSync(
    join(dir, "script", "notify.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";
     writeFileSync("delivered.json", readFileSync(0, "utf8"));`,
  );
  writeFileSync(
    join(dir, ".pitwall.json"),
    JSON.stringify({ notify: [execPath, "script/notify.mjs"] }),
  );
  const delivery = await workspaceSender(dir, { env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.deepEqual(delivery, { delivered: true });
  assert.equal(JSON.parse(readFileSync(log, "utf8")).issueId, "mw-1");
});
