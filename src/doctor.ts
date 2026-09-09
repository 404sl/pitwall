import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { LEGACY_WORKSPACE_FILE, WORKSPACE_FILE, WORKSPACE_FILES, workspaceFile } from "./autofix.js";
import { BEADS_DIR, BEADS_DIR_VAR } from "./beads.js";
import { describeRoots, resolveRoots, type ResolvedRoots, type RootsOptions } from "./config.js";
import { failureOf } from "./errors.js";
import { defaultBranchOf, remoteSlugOf } from "./git.js";
import { slotsPath } from "./lanes.js";
import { painter } from "./status.js";
import { VERSION } from "./version.js";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

const GH_COST = "pull request state and staleness stay unchecked";
const BD_COST = "no issue can be read and every project reads as empty";

export type Severity = "ok" | "warn" | "fail";

export interface Check {
  severity: Severity;
  name: string;
  tried: string;
  result: string;
}

export interface Diagnosis {
  checks: Check[];
  code: number;
}

export interface DoctorOptions extends RootsOptions {
  timeoutMs?: number;
}

export interface DoctorRenderOptions {
  color?: boolean;
}

type Asked = { ok: true; stdout: string } | { ok: false; missing: boolean; why: string };

async function ask(
  program: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Asked> {
  try {
    const { stdout } = await run(program, args as string[], {
      encoding: "utf8",
      env,
      maxBuffer: MAX_OUTPUT,
      timeout: timeoutMs,
    });
    return { ok: true, stdout };
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, missing, why: failureOf(cause, timeoutMs) };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function triedOf(roots: ResolvedRoots): string {
  return roots.source === "config" ? `read ${roots.configPath}` : `scan ${roots.from}`;
}

function rootsCheck(roots: ResolvedRoots): Check {
  const rejected = roots.errors.some((error) => error.source === roots.configPath);
  const severity: Severity =
    roots.roots.length === 0 ? "fail" : rejected ? "warn" : "ok";
  return { severity, name: "roots", tried: triedOf(roots), result: describeRoots(roots) };
}

function timesListed(roots: ResolvedRoots): Map<string, number> {
  const counted = new Map<string, number>();
  for (const root of roots.roots) {
    const dir = resolve(root);
    counted.set(dir, (counted.get(dir) ?? 0) + 1);
  }
  return counted;
}

function repeatedRootChecks(roots: ResolvedRoots, counted: ReadonlyMap<string, number>): Check[] {
  return [...counted]
    .filter(([, times]) => times > 1)
    .map(([dir, times]) => ({
      severity: "fail" as const,
      name: `${basename(dir)} listed`,
      tried: triedOf(roots),
      result: `${dir} is listed ${times} times · the console reports this workspace ${times} times`,
    }));
}

async function ghCheck(
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Check> {
  const tried = "gh auth status";
  const asked = await ask("gh", ["auth", "status"], env, timeoutMs);
  if (asked.ok) {
    return { severity: "ok", name: "gh", tried, result: "authenticated" };
  }
  const why = asked.missing ? "gh is not on PATH" : asked.why;
  return { severity: "warn", name: "gh", tried, result: `${why} - ${GH_COST}` };
}

function statusCountOf(stdout: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const listed = ["built_in_statuses", "custom_statuses"].map((key) =>
    (parsed as Record<string, unknown>)[key],
  );
  const counted = listed
    .filter((value): value is unknown[] => Array.isArray(value))
    .reduce((total, value) => total + value.length, 0);
  return counted === 0 ? undefined : counted;
}

async function bdCheck(
  id: string,
  beadsDir: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Check> {
  const name = `${id} bd`;
  const tried = `${BEADS_DIR_VAR}=${beadsDir} bd statuses --json`;
  const asked = await ask("bd", ["statuses", "--json"], { ...env, [BEADS_DIR_VAR]: beadsDir }, timeoutMs);
  if (!asked.ok) {
    const why = asked.missing ? "bd is not on PATH" : asked.why;
    return { severity: "fail", name, tried, result: `${why} - ${BD_COST}` };
  }
  const statuses = statusCountOf(asked.stdout);
  return {
    severity: "ok",
    name,
    tried,
    result: statuses === undefined ? "answered" : `answered with ${statuses} statuses`,
  };
}

function repoEntries(workspace: Record<string, unknown>): [string, unknown][] {
  const repos = workspace["repos"];
  if (repos === undefined) {
    return [];
  }
  return Object.entries(asRecord(repos, "repos")).filter(([name]) => !name.startsWith("_"));
}

function repoCheck(id: string, dir: string, name: string, value: unknown): Check {
  const label = `${id} repo ${name}`;
  let path: unknown;
  try {
    path = asRecord(value, `repo ${name}`)["path"];
  } catch (cause) {
    return { severity: "fail", name: label, tried: `read repo ${name}`, result: messageOf(cause) };
  }
  if (typeof path !== "string") {
    return { severity: "fail", name: label, tried: `read repo ${name}`, result: "no path" };
  }
  const repo = resolve(dir, path);
  const tried = `stat ${repo}`;
  if (!isDirectory(repo)) {
    return { severity: "fail", name: label, tried, result: `no directory at ${repo}` };
  }
  if (!existsSync(join(repo, ".git"))) {
    return { severity: "fail", name: label, tried, result: `${repo} is not a git checkout` };
  }
  const slug = remoteSlugOf(repo) ?? "no origin remote";
  const branch = defaultBranchOf(repo) ?? "no origin/HEAD";
  return { severity: "ok", name: label, tried, result: `${slug} · ${branch}` };
}

function lanesCheck(
  id: string,
  file: string,
  workspace: Record<string, unknown>,
  lockRoot: string | undefined,
): { check: Check; lockPrefix?: string } {
  const name = `${id} lanes`;
  const prefix = workspace["lockPrefix"];
  if (typeof prefix !== "string" || prefix === "") {
    return {
      check: {
        severity: "warn",
        name,
        tried: `read lockPrefix from ${file}`,
        result: "no lockPrefix - no lane is reported for this workspace",
      },
    };
  }
  const slots = slotsPath(prefix, lockRoot);
  return {
    check: {
      severity: "ok",
      name,
      tried: `stat ${slots}`,
      result: isDirectory(slots)
        ? `lockPrefix ${prefix} · the slot registry is here`
        : `lockPrefix ${prefix} · no slot registry yet, so no lane has run`,
    },
    lockPrefix: prefix,
  };
}

function sharedPrefixChecks(
  claims: ReadonlyMap<string, string[]>,
  lockRoot: string | undefined,
): Check[] {
  const shared = [...claims].filter(([, roots]) => roots.length > 1);
  if (shared.length === 0) {
    return claims.size === 0
      ? []
      : [
          {
            severity: "ok",
            name: "lockPrefix",
            tried: `compare lockPrefix across ${claims.size} workspace${claims.size === 1 ? "" : "s"}`,
            result: "every workspace locks under a prefix of its own",
          },
        ];
  }
  return shared.map(([prefix, roots]) => ({
    severity: "fail" as const,
    name: "lockPrefix",
    tried: "compare lockPrefix across workspaces",
    result: `${roots.join(" and ")} both lock under ${slotsPath(prefix, lockRoot)} - the lane lock stops protecting either`,
  }));
}

interface WorkspaceReading {
  checks: Check[];
  lockPrefix?: string;
}

async function workspaceChecks(root: string, options: DoctorOptions): Promise<WorkspaceReading> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const dir = resolve(root);
  const id = basename(dir);
  const checks: Check[] = [];
  if (!isDirectory(dir)) {
    checks.push({ severity: "fail", name: id, tried: `stat ${dir}`, result: "no directory here" });
    return { checks };
  }
  const found = workspaceFile(dir);
  if (found === undefined) {
    return {
      checks: [
        {
          severity: "fail",
          name: id,
          tried: `read ${join(dir, WORKSPACE_FILE)}`,
          result: `no ${WORKSPACE_FILES.join(" or ")} in ${dir}`,
        },
      ],
    };
  }
  let workspace: Record<string, unknown>;
  let repos: [string, unknown][];
  try {
    workspace = asRecord(JSON.parse(readFileSync(found.path, "utf8")), found.name);
    repos = repoEntries(workspace);
  } catch (cause) {
    return {
      checks: [
        { severity: "fail", name: id, tried: `read ${found.path}`, result: messageOf(cause) },
      ],
    };
  }
  const both = WORKSPACE_FILES.every((name) => existsSync(join(dir, name)));
  checks.push({
    severity: both ? "warn" : "ok",
    name: id,
    tried: `read ${found.path}`,
    result: both
      ? `${found.name} is in use and ${LEGACY_WORKSPACE_FILE} beside it is dead weight`
      : `${repos.length} repo${repos.length === 1 ? "" : "s"} · idPrefix ${workspace["idPrefix"] ?? "unset"}`,
  });
  const declared = workspace["root"];
  if (typeof declared === "string") {
    const points = resolve(declared);
    checks.push({
      severity: points === dir ? "ok" : "fail",
      name: `${id} root`,
      tried: `compare root in ${found.name} with ${dir}`,
      result: points === dir ? "root names this directory" : `root names ${points}, not this directory`,
    });
  }
  const beadsDir = join(dir, BEADS_DIR);
  checks.push({
    severity: isDirectory(beadsDir) ? "ok" : "fail",
    name: `${id} tracker`,
    tried: `stat ${beadsDir}`,
    result: isDirectory(beadsDir) ? "a tracker is here" : `no ${BEADS_DIR} directory here`,
  });
  checks.push(await bdCheck(id, beadsDir, env, timeoutMs));
  for (const [name, value] of repos) {
    checks.push(repoCheck(id, dir, name, value));
  }
  const lanes = lanesCheck(id, found.name, workspace, options.lockRoot);
  checks.push(lanes.check);
  return { checks, lockPrefix: lanes.lockPrefix };
}

export async function diagnose(options: DoctorOptions = {}): Promise<Diagnosis> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const roots = resolveRoots(options);
  const counted = timesListed(roots);
  const checks: Check[] = [
    rootsCheck(roots),
    ...repeatedRootChecks(roots, counted),
    await ghCheck(env, timeoutMs),
  ];
  const claims = new Map<string, string[]>();
  for (const root of counted.keys()) {
    const reading = await workspaceChecks(root, options);
    checks.push(...reading.checks);
    if (reading.lockPrefix !== undefined) {
      claims.set(reading.lockPrefix, [...(claims.get(reading.lockPrefix) ?? []), resolve(root)]);
    }
  }
  checks.push(...sharedPrefixChecks(claims, options.lockRoot));
  return { checks, code: checks.some((check) => check.severity === "fail") ? 1 : 0 };
}

const MARKER: Record<Severity, string> = { ok: "ok", warn: "warn", fail: "fail" };
const COLOUR: Record<Severity, string> = { ok: "2", warn: "33", fail: "31" };
const MARKER_WIDTH = 4;

const REMEDY = "until these are fixed, an empty screen is not an empty backlog.";
const CLEAN = "nothing to fix.";

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function countOf(checks: readonly Check[], severity: Severity): number {
  return checks.filter((check) => check.severity === severity).length;
}

function summaryOf(checks: readonly Check[]): string {
  const failed = countOf(checks, "fail");
  const warned = countOf(checks, "warn");
  const checked = `${checks.length} checked`;
  if (failed === 0 && warned === 0) {
    return `  ${checked} · ${CLEAN}`;
  }
  const counts = [`${failed} failed`, `${warned} warned`, checked].join(" · ");
  return failed === 0 ? `  ${counts}` : `  ${counts} · ${REMEDY}`;
}

export function renderDoctor(diagnosis: Diagnosis, options: DoctorRenderOptions = {}): string {
  const paint = painter(options.color ?? false);
  const nameWidth = widest(diagnosis.checks.map((check) => check.name));
  const lines = [`${paint("pitwall", "1")} ${paint(VERSION, "2")} · doctor`, ""];
  for (const check of diagnosis.checks) {
    const marker = paint(MARKER[check.severity].padEnd(MARKER_WIDTH), COLOUR[check.severity]);
    lines.push(`  ${marker}  ${check.name.padEnd(nameWidth)}  ${check.tried} · ${check.result}`);
  }
  lines.push("", summaryOf(diagnosis.checks));
  return `${lines.join("\n")}\n`;
}
