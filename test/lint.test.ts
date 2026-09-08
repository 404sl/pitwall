import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

function lintConfigs(): string[] {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  return [...(pkg.scripts.lint ?? "").matchAll(/-p\s+(\S+)/g)].map((m) => m[1] as string);
}

function programFiles(config: string): string[] {
  const out = execFileSync(process.execPath, [TSC, "-p", config, "--listFilesOnly"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => relative(ROOT, line.trim()))
    .filter((path) => path !== "" && !path.startsWith("..") && !path.startsWith("node_modules"));
}

test("lint typechecks every directory the package ships, not just src", () => {
  const configs = lintConfigs();
  assert.ok(configs.length > 0, "the lint script names no tsconfig");

  const covered = new Set(configs.flatMap(programFiles));
  for (const path of ["src/cli.ts", "ui/main.tsx", "test/console.test.ts"]) {
    assert.ok(covered.has(path), `${path} is not typechecked by npm run lint`);
  }
});
