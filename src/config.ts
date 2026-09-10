import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CollectionError, Project } from "@404sl/pitwall-schema";
import { readWorkspace, workspaceFile } from "./autofix.js";
import { collectionError } from "./errors.js";
import { DEFAULT_LIMITS, type HistoryLimits } from "./history.js";

export const CONFIG_VAR = "PITWALL_CONFIG";

export type RootsSource = "config" | "scan";

export interface RootsOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
  lockRoot?: string;
}

export interface ResolvedRoots {
  roots: string[];
  listed: string[];
  source: RootsSource;
  from: string;
  configPath: string;
  errors: CollectionError[];
}

type LocatedRoots = Omit<ResolvedRoots, "roots">;

export function configPath(options: RootsOptions = {}): string {
  const override = (options.env ?? process.env)[CONFIG_VAR];
  if (override !== undefined && override !== "") {
    return resolve(override);
  }
  return join(options.home ?? homedir(), ".config", "pitwall", "config.json");
}

function readRoots(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { roots?: unknown } | null;
  const roots = parsed?.roots;
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
    throw new TypeError("roots is not an array of paths");
  }
  return (roots as string[]).map((root) => resolve(root));
}

interface HistoryConfig {
  maxSnapshots?: unknown;
  maxAgeDays?: unknown;
  minIntervalMinutes?: unknown;
}

function bound(value: unknown, fallback: number, whole: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return whole ? Math.floor(value) : value;
}

export function historyLimits(options: RootsOptions = {}): HistoryLimits {
  let configured: HistoryConfig = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath(options), "utf8")) as {
      history?: HistoryConfig | null;
    } | null;
    configured = parsed?.history ?? {};
  } catch {
    configured = {};
  }
  return {
    maxSnapshots: Math.max(bound(configured.maxSnapshots, DEFAULT_LIMITS.maxSnapshots, true), 1),
    maxAgeDays: bound(configured.maxAgeDays, DEFAULT_LIMITS.maxAgeDays, false),
    minIntervalMinutes: bound(
      configured.minIntervalMinutes,
      DEFAULT_LIMITS.minIntervalMinutes,
      false,
    ),
  };
}

function scanForWorkspaces(parent: string, errors: CollectionError[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch (cause) {
    errors.push(collectionError(parent, cause));
    return [];
  }
  return entries
    .map((entry) => join(parent, entry))
    .filter((dir) => workspaceFile(dir) !== undefined)
    .sort();
}

function locateRoots(options: RootsOptions): LocatedRoots {
  const path = configPath(options);
  const errors: CollectionError[] = [];
  if (existsSync(path)) {
    try {
      return { listed: readRoots(path), source: "config", from: path, configPath: path, errors };
    } catch (cause) {
      errors.push(collectionError(path, cause));
    }
  }
  const parent = dirname(resolve(options.cwd ?? process.cwd()));
  return {
    listed: scanForWorkspaces(parent, errors),
    source: "scan",
    from: parent,
    configPath: path,
    errors,
  };
}

export function resolveRoots(options: RootsOptions = {}): ResolvedRoots {
  const located = locateRoots(options);
  const resolved: ResolvedRoots = { ...located, roots: [...new Set(located.listed)] };
  if (resolved.roots.length === 0) {
    resolved.errors.push(collectionError(resolved.from, describeRoots(resolved)));
  }
  return resolved;
}

export function describeRoots(resolved: ResolvedRoots): string {
  const count = `${resolved.roots.length} workspace root${resolved.roots.length === 1 ? "" : "s"}`;
  if (resolved.source === "config") {
    return `${count} from ${resolved.from}`;
  }
  const rejected = resolved.errors.find((error) => error.source === resolved.configPath);
  if (rejected) {
    return `${count} found by falling back to scanning ${resolved.from}, because the config at ${resolved.configPath} could not be read: ${rejected.message}`;
  }
  return `${count} found by falling back to scanning ${resolved.from}, because there is no config at ${resolved.configPath}`;
}

export function collectProjects(options: RootsOptions = {}): {
  projects: Project[];
  roots: ResolvedRoots;
} {
  const roots = resolveRoots(options);
  return {
    projects: roots.roots.map((root) =>
      readWorkspace(root, { lockRoot: options.lockRoot, env: options.env }),
    ),
    roots,
  };
}
