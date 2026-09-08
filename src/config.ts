import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CollectionError, Project } from "@404sl/pitwall-schema";
import { AUTOFIX_FILE, collectionError, readWorkspace } from "./autofix.js";

export const CONFIG_VAR = "PITWALL_CONFIG";

export type RootsSource = "config" | "scan";

export interface RootsOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
}

export interface ResolvedRoots {
  roots: string[];
  source: RootsSource;
  from: string;
  configPath: string;
  errors: CollectionError[];
}

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
    .filter((dir) => existsSync(join(dir, AUTOFIX_FILE)))
    .sort();
}

export function resolveRoots(options: RootsOptions = {}): ResolvedRoots {
  const path = configPath(options);
  const errors: CollectionError[] = [];
  if (existsSync(path)) {
    try {
      return { roots: readRoots(path), source: "config", from: path, configPath: path, errors };
    } catch (cause) {
      errors.push(collectionError(path, cause));
    }
  }
  const parent = dirname(resolve(options.cwd ?? process.cwd()));
  return {
    roots: scanForWorkspaces(parent, errors),
    source: "scan",
    from: parent,
    configPath: path,
    errors,
  };
}

export function describeRoots(resolved: ResolvedRoots): string {
  const count = `${resolved.roots.length} workspace root${resolved.roots.length === 1 ? "" : "s"}`;
  if (resolved.source === "config") {
    return `${count} from ${resolved.from}`;
  }
  const rejected = resolved.errors.find((error) => error.source === resolved.configPath);
  if (rejected) {
    return `${count} found by scanning ${resolved.from}, because the config at ${resolved.configPath} could not be read: ${rejected.message}`;
  }
  return `${count} found by scanning ${resolved.from}, because there is no config at ${resolved.configPath}`;
}

export function collectProjects(options: RootsOptions = {}): {
  projects: Project[];
  roots: ResolvedRoots;
} {
  const roots = resolveRoots(options);
  return { projects: roots.roots.map((root) => readWorkspace(root)), roots };
}
