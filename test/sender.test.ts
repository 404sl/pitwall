import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Origin } from "@404sl/pitwall-schema";
import type { CollectionNotice, Notice } from "../src/notify.ts";
import {
  SESSION_REF_FIELD,
  SESSION_REF_VAR,
  commandSender,
  outboundPath,
  sessionRefOf,
  workspaceSender,
} from "../src/sender.ts";

const LISTED = { source: "config", configPath: "/nowhere/config.json" } as const;

const ASKED: Origin = { session: "dev-loop", ref: "c1796a" };

const NOTICE: Notice = {
  kind: "completion",
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
    kind: "completion",
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
  assert.equal(sessionRefOf(configured, { ...LISTED, env: {} }), "from-file");
  assert.equal(
    sessionRefOf(configured, { ...LISTED, env: { [SESSION_REF_VAR]: "from-env" } }),
    "from-env",
  );
  assert.equal(sessionRefOf(configured, { ...LISTED, env: { [SESSION_REF_VAR]: "" } }), "from-file");
  assert.equal(sessionRefOf(root({}), { ...LISTED, env: {} }), undefined);
  assert.equal(sessionRefOf(root(undefined), { ...LISTED, env: {} }), undefined);
});

test("with no ref for the collecting session every notice is held and says why", async () => {
  const dir = root({ notify: ["true"] });
  const delivery = await workspaceSender(dir, { ...LISTED, env: {} })(NOTICE);
  assert.equal(delivery.delivered, false);
  const reason = delivery.delivered ? "" : delivery.reason;
  assert.match(reason, new RegExp(`${SESSION_REF_VAR} is not set`));
  assert.match(reason, /cannot tell its own work from another session's/);
});

test("a workspace that configures no command holds its notices and names the field", async () => {
  const dir = root({ idPrefix: "mw" });
  const delivery = await workspaceSender(dir, { ...LISTED, env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /no notify command is configured/);
});

test("a notify field that is not a command is refused with a reason", async () => {
  const dir = root({ notify: "say-something" });
  const delivery = await workspaceSender(dir, { ...LISTED, env: {}, sessionRef: "9f31bd" })(NOTICE);
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
  const delivery = await workspaceSender(dir, { ...LISTED, env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.deepEqual(delivery, { delivered: true });
  assert.equal(JSON.parse(readFileSync(log, "utf8")).issueId, "mw-1");
});

test("a workspace nobody listed never runs the command its own file names", async () => {
  const dir = root(undefined);
  const log = join(dir, "ran.txt");
  writeFileSync(
    join(dir, "notify.mjs"),
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(log)}, "ran");`,
  );
  writeFileSync(
    join(dir, ".pitwall.json"),
    JSON.stringify({ notify: [execPath, join(dir, "notify.mjs")] }),
  );
  const scanned = { source: "scan", configPath: "/home/someone/.config/pitwall/config.json" } as const;
  const delivery = await workspaceSender(dir, { ...scanned, env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.equal(delivery.delivered, false);
  const reason = delivery.delivered ? "" : delivery.reason;
  assert.match(reason, /was found by scanning for workspaces/);
  assert.match(reason, new RegExp(scanned.configPath));
  assert.equal(existsSync(log), false);
});

test("a root of unstated provenance is treated as scanned, not as listed", async () => {
  const dir = root({ notify: ["true"] });
  const delivery = await workspaceSender(dir, { env: {}, sessionRef: "9f31bd" })(NOTICE);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.delivered ? "" : delivery.reason, /was found by scanning for workspaces/);
});

test(`a scanned workspace cannot name the collecting session either, only ${SESSION_REF_VAR} can`, () => {
  const dir = root({ [SESSION_REF_FIELD]: "from-file" });
  assert.equal(sessionRefOf(dir, { source: "scan", env: {} }), undefined);
  assert.equal(
    sessionRefOf(dir, { source: "scan", env: { [SESSION_REF_VAR]: "from-env" } }),
    "from-env",
  );
});

const OUTAGE: CollectionNotice = {
  kind: "collection-failed",
  since: "2026-09-10T15:49:00Z",
  forMs: 65_400_000,
  text: "Collection has failed for 18h10m, every attempt since 2026-09-10T15:49:00Z. The board is not current.",
};

function config(roots: readonly string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "pitwall-config-")), "config.json");
  writeFileSync(path, JSON.stringify({ roots }));
  return path;
}

test("the console's one outbound path is the first listed workspace that names a command", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "pitwall-outage-")), "notice.json");
  const path = script(
    `import { readFileSync, writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(log)}, readFileSync(0, "utf8"));`,
  );
  const quiet = root({ idPrefix: "q" });
  const named = root({ idPrefix: "mw", notify: [execPath, path] });
  const found = outboundPath({ env: { PITWALL_CONFIG: config([quiet, named]) } });
  if ("reason" in found) {
    assert.fail(found.reason);
  }

  assert.deepEqual(await found.send(OUTAGE), { delivered: true });
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), OUTAGE);
});

test("a console whose workspaces were only found by scanning has no outbound path", () => {
  const parent = mkdtempSync(join(tmpdir(), "pitwall-scan-"));
  const child = join(parent, "alpha");
  mkdirSync(child);
  writeFileSync(join(child, ".pitwall.json"), JSON.stringify({ notify: ["true"] }));
  const found = outboundPath({
    env: { PITWALL_CONFIG: join(parent, "no-config.json") },
    cwd: child,
  });
  if (!("reason" in found)) {
    assert.fail("a scanned workspace must never be run");
  }
  assert.match(found.reason, /found by scanning/);
  assert.match(found.reason, /listed in roots/);
});

test("a listed workspace that names no command is a reason the board can carry", () => {
  const found = outboundPath({ env: { PITWALL_CONFIG: config([root({ idPrefix: "mw" })]) } });
  if (!("reason" in found)) {
    assert.fail("there is nothing to deliver through");
  }
  assert.match(found.reason, /no notify command is configured/);
});
