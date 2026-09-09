import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { VERSION } from "../src/version.js";

const ROOT = join(import.meta.dirname, "..");

test("the version constant matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  // src/version.ts is hand-maintained because the compiled CLI ships without its manifest.
  // Nothing kept it in step, so a published release reported the previous version.
  assert.equal(VERSION, pkg.version, "src/version.ts and package.json disagree");
});

// THE CHECK NOBODY WROTE, AND THE ONLY ONE THAT WOULD HAVE CAUGHT IT.
//
// The CLI decided whether it had been run or imported by comparing the BASENAME of argv[1]
// against its own module URL. That is true when you run `node dist/cli.js` and false for every
// installed copy, because npm links the binary as `pitwall` while the module is still cli.js.
// So the published package did nothing at all: no output, no error, exit 0.
//
// Every existing test invoked it by its own filename, which is the one way it worked.
test("the binary runs when invoked under the name npm installs it as", () => {
  const link = join(tmpdir(), `pitwall-entrypoint-${process.pid}`);
  try {
    const built = join(ROOT, "dist", "cli.js");
    assert.ok(
      existsSync(built),
      "dist/cli.js is missing - this test exercises the COMPILED binary, so the build has to run first",
    );
    rmSync(link, { force: true });
    symlinkSync(built, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    assert.match(out, /^pitwall \d+\.\d+\.\d+/, `invoked as "${link}" it printed nothing`);
  } finally {
    rmSync(link, { force: true });
  }
});
