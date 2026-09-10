import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");

const MARKETPLACE = join(".claude-plugin", "marketplace.json");
const PLUGIN = join("plugins", "devloop", ".claude-plugin", "plugin.json");

function readManifest(root: string, relative: string): unknown {
  const path = join(root, relative);
  assert.ok(existsSync(path), `${relative} is missing - the devloop plugin version cannot be checked without it`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function declaredVersion(value: unknown, where: string): string {
  const version = (value as { version?: unknown }).version;
  assert.equal(typeof version, "string", `${where} declares no "version" string`);
  assert.notEqual(version, "", `${where} declares an empty "version"`);
  return version as string;
}

function marketplaceVersion(root: string): string {
  const manifest = readManifest(root, MARKETPLACE) as { plugins?: { name?: string }[] };
  const plugins = manifest.plugins ?? [];
  const entry = plugins.find((plugin) => plugin.name === "devloop");
  assert.ok(entry, `${MARKETPLACE} has no plugin entry named "devloop"`);
  return declaredVersion(entry, `${MARKETPLACE} (devloop entry)`);
}

function assertManifestVersionsAgree(root: string): void {
  const marketplace = marketplaceVersion(root);
  const plugin = declaredVersion(readManifest(root, PLUGIN), PLUGIN);
  assert.equal(
    marketplace,
    plugin,
    `the devloop plugin version disagrees across its manifests: ${MARKETPLACE} says ${marketplace}, ${PLUGIN} says ${plugin}. Bump both or neither.`,
  );
}

function fixture(marketplace: string | null, plugin: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-manifest-"));
  for (const [relative, version] of [[MARKETPLACE, marketplace], [PLUGIN, plugin]] as const) {
    if (version === null) continue;
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    const body =
      relative === MARKETPLACE
        ? { name: "pitwall", plugins: [{ name: "devloop", version }] }
        : { name: "devloop", version };
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  }
  return root;
}

test("the devloop plugin declares one version across both of its manifests", () => {
  assertManifestVersionsAgree(ROOT);
});

test("a one-file version bump fails the run", () => {
  assert.throws(
    () => assertManifestVersionsAgree(fixture("0.1.21", "0.1.22")),
    /marketplace\.json says 0\.1\.21.*plugin\.json says 0\.1\.22/s,
  );
});

test("a missing marketplace manifest fails the run, naming the file", () => {
  assert.throws(() => assertManifestVersionsAgree(fixture(null, "0.1.21")), /marketplace\.json is missing/);
});

test("a missing plugin manifest fails the run, naming the file", () => {
  assert.throws(() => assertManifestVersionsAgree(fixture("0.1.21", null)), /plugin\.json is missing/);
});

test("a manifest with no version field fails the run rather than comparing nothing", () => {
  const root = fixture("0.1.21", "0.1.21");
  writeFileSync(join(root, PLUGIN), `${JSON.stringify({ name: "devloop" }, null, 2)}\n`);
  assert.throws(() => assertManifestVersionsAgree(root), /plugin\.json declares no "version" string/);
});
