import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = 10_000;
const COMMIT = /^[0-9a-f]{40}$/;

function option(name, fallback) {
  const flag = `--${name}=`;
  const given = process.argv.slice(2).find((arg) => arg.startsWith(flag));
  return given === undefined ? fallback : given.slice(flag.length);
}

const repo = resolve(option("repo", ROOT));
const out = resolve(option("out", join(ROOT, "dist", "build.json")));

function say(message) {
  process.stdout.write(`pitwall build: ${message}\n`);
}

function commitOf() {
  if (!existsSync(join(repo, ".git"))) {
    return undefined;
  }
  const read = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: TIMEOUT_MS });
  if (read.error !== undefined || read.status !== 0) {
    return undefined;
  }
  const commit = (read.stdout ?? "").trim();
  return COMMIT.test(commit) ? commit : undefined;
}

const commit = commitOf();
if (commit === undefined) {
  say(`no commit to stamp at ${repo}; the console will report its build as unknown`);
  process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ commit, at: new Date().toISOString() }, null, 2)}\n`);
say(`stamped ${commit.slice(0, 7)} into ${out}`);
