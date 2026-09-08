import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Project, type RepoKind } from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";
import { readLanes } from "./lanes.js";

export const AUTOFIX_FILE = ".autofix.json";

export interface WorkspaceOptions {
  lockRoot?: string;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

// TODO: drop once .autofix.json carries repos.<name>.kind
function repoKind(deploy: unknown): RepoKind {
  return Array.isArray(deploy) && deploy.length > 0 ? "deployable" : "library";
}

function repoPath(root: string, name: string, repo: Record<string, unknown>): string {
  const path = repo["path"];
  if (typeof path !== "string") {
    throw new TypeError(`repo ${name} has no path`);
  }
  return resolve(root, path);
}

function reposOf(root: string, workspace: Record<string, unknown>): unknown[] {
  const repos = workspace["repos"];
  if (repos === undefined) {
    return [];
  }
  return Object.entries(asRecord(repos, "repos"))
    .filter(([name]) => !name.startsWith("_"))
    .map(([name, value]) => {
      const repo = asRecord(value, `repo ${name}`);
      return { name, path: repoPath(root, name, repo), kind: repoKind(repo["deploy"]) };
    });
}

function lockPrefixOf(workspace: Record<string, unknown>): string | undefined {
  const prefix = workspace["lockPrefix"];
  if (prefix === undefined) {
    return undefined;
  }
  if (typeof prefix !== "string" || prefix === "") {
    throw new TypeError("lockPrefix is not a name");
  }
  return prefix;
}

function laneCountOf(workspace: Record<string, unknown>): number | undefined {
  const lanes = workspace["lanes"];
  return typeof lanes === "number" && Number.isInteger(lanes) && lanes > 0 ? lanes : undefined;
}

export function readWorkspace(root: string, options: WorkspaceOptions = {}): Project {
  const dir = resolve(root);
  const file = join(dir, AUTOFIX_FILE);
  const skeleton = { id: basename(dir), name: basename(dir), root: dir, metrics: {} };
  try {
    const workspace = asRecord(JSON.parse(readFileSync(file, "utf8")), AUTOFIX_FILE);
    const lockPrefix = lockPrefixOf(workspace);
    const reading =
      lockPrefix === undefined
        ? { lanes: [], errors: [] }
        : readLanes(lockPrefix, {
            lockRoot: options.lockRoot,
            lanes: laneCountOf(workspace),
          });
    return Project.parse({
      ...skeleton,
      authority: { kind: "beads", idPrefix: workspace["idPrefix"] },
      repos: reposOf(dir, workspace),
      lanes: reading.lanes,
      errors: reading.errors,
    });
  } catch (cause) {
    return Project.parse({
      ...skeleton,
      authority: { kind: "beads" },
      errors: [collectionError(file, cause)],
    });
  }
}
