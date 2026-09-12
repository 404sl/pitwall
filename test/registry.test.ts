import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_EVERY_MS, REGISTRY_URL, createUpdateCheck, newerThan, readPublished } from "../src/registry.ts";

const RUNNING = "0.1.2";

function answering(bodies: Array<Response | Error>): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = ((url: string | URL | Request) => {
    calls.push(String(url));
    const next = bodies.shift();
    if (next === undefined || next instanceof Error) {
      return Promise.reject(next ?? new Error("no answer left"));
    }
    return Promise.resolve(next);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function published(version: unknown): Response {
  return new Response(JSON.stringify({ version }), { status: 200 });
}

test("a newer release is one strictly ahead of the running version", () => {
  assert.equal(newerThan("0.1.3", "0.1.2"), true);
  assert.equal(newerThan("0.2.0", "0.1.9"), true);
  assert.equal(newerThan("1.0.0", "0.9.9"), true);
  assert.equal(newerThan("0.1.2", "0.1.2"), false);
  assert.equal(newerThan("0.1.1", "0.1.2"), false);
  assert.equal(newerThan("0.2.0-rc.1", "0.1.2"), false);
  assert.equal(newerThan("latest", "0.1.2"), false);
});

test("a check that finds a newer release reports it", async () => {
  const { fetch, calls } = answering([published("0.1.3")]);
  const check = createUpdateCheck({ running: RUNNING, fetch });
  await check.refresh();
  assert.equal(check.update(), "0.1.3");
  assert.deepEqual(calls, [REGISTRY_URL]);
});

test("the registry it asks is npm, unauthenticated", () => {
  assert.equal(REGISTRY_URL, "https://registry.npmjs.org/@404sl/pitwall/latest");
  assert.equal(CHECK_EVERY_MS >= 3_600_000, true, "checks may not run more often than hourly");
});

test("a published version that is not newer is not an update", async () => {
  const { fetch } = answering([published(RUNNING)]);
  const check = createUpdateCheck({ running: RUNNING, fetch });
  await check.refresh();
  assert.equal(check.update(), undefined);
});

test("a registry that cannot be reached is silent, and claims no update", async () => {
  const { fetch } = answering([new Error("getaddrinfo ENOTFOUND registry.npmjs.org")]);
  const check = createUpdateCheck({ running: RUNNING, fetch });
  await check.refresh();
  assert.equal(check.update(), undefined);
});

test("a registry answer that is not a version is not an update", async () => {
  for (const answer of [
    new Response("not json at all", { status: 200 }),
    new Response("{}", { status: 500 }),
    published(undefined),
    published(3),
    new Response("null", { status: 200 }),
  ]) {
    const { fetch } = answering([answer]);
    const check = createUpdateCheck({ running: RUNNING, fetch });
    await check.refresh();
    assert.equal(check.update(), undefined);
  }
});

test("an update once found survives a later check that fails or goes backwards", async () => {
  let now = 0;
  const { fetch } = answering([
    published("0.1.4"),
    new Error("network down"),
    published("0.1.3"),
  ]);
  const check = createUpdateCheck({ running: RUNNING, fetch, now: () => now });
  await check.refresh();
  assert.equal(check.update(), "0.1.4");
  now += CHECK_EVERY_MS;
  await check.refresh();
  assert.equal(check.update(), "0.1.4");
  now += CHECK_EVERY_MS;
  await check.refresh();
  assert.equal(check.update(), "0.1.4");
});

test("the registry is not asked again inside the hour", async () => {
  let now = 0;
  const { fetch, calls } = answering([published(RUNNING), published("0.1.3")]);
  const check = createUpdateCheck({ running: RUNNING, fetch, now: () => now });
  await check.refresh();
  now += CHECK_EVERY_MS - 1;
  await check.refresh();
  await check.refresh();
  assert.equal(calls.length, 1);
  now += 1;
  await check.refresh();
  assert.equal(calls.length, 2);
  assert.equal(check.update(), "0.1.3");
});

test("reading the update never waits on the registry, and never rejects", async () => {
  const { fetch, calls } = answering([new Error("network down")]);
  const check = createUpdateCheck({ running: RUNNING, fetch });
  assert.equal(check.update(), undefined);
  assert.equal(calls.length, 1);
  await check.refresh();
  assert.equal(check.update(), undefined);
});

test("a fresh read reports what the registry publishes now, even when the cache holds something newer", async () => {
  const { fetch, calls } = answering([published("0.1.4"), published(RUNNING)]);
  const check = createUpdateCheck({ running: RUNNING, fetch });
  await check.refresh();
  assert.equal(check.update(), "0.1.4");
  assert.equal(await readPublished({ fetch }), RUNNING);
  assert.deepEqual(calls, [REGISTRY_URL, REGISTRY_URL]);
});

test("a fresh read of a registry that cannot be reached or cannot be parsed reports nothing", async () => {
  for (const answer of [
    new Error("network down"),
    new Response("not json at all", { status: 200 }),
    new Response("{}", { status: 500 }),
    published(undefined),
    published(3),
  ]) {
    const { fetch } = answering([answer]);
    assert.equal(await readPublished({ fetch }), undefined);
  }
});
