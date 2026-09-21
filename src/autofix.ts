import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Project, type CollectionError, type RepoKind } from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";
import { defaultBranchOf, remoteOf } from "./git.js";
import { readLanes } from "./lanes.js";

export const WORKSPACE_FILE = ".pitwall.json";
export const LEGACY_WORKSPACE_FILE = ".autofix.json";
export const WORKSPACE_FILES = [WORKSPACE_FILE, LEGACY_WORKSPACE_FILE] as const;

export interface WorkspaceFile {
  name: string;
  path: string;
}

export function workspaceFile(dir: string): WorkspaceFile | undefined {
  for (const name of WORKSPACE_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) {
      return { name, path };
    }
  }
  return undefined;
}

export interface WorkspaceOptions {
  lockRoot?: string;
  env?: Record<string, string | undefined>;
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

function defaultBranchIn(name: string, repo: Record<string, unknown>): string | undefined {
  const branch = repo["defaultBranch"];
  if (branch === undefined) {
    return undefined;
  }
  if (typeof branch !== "string" || branch === "") {
    throw new TypeError(`repo ${name} defaultBranch is not a branch name`);
  }
  return branch;
}

interface WorkspaceRepo {
  name: string;
  path: string;
  kind: RepoKind;
  defaultBranch?: string;
}

function unreadDefaultBranch(path: string, file: string): CollectionError | undefined {
  if (remoteOf(path).slug === undefined) {
    return undefined;
  }
  return {
    source: path,
    message: `no origin/HEAD, so the default branch could not be read - set defaultBranch in ${file} or run git remote set-head origin -a`,
    at: new Date().toISOString(),
    scope: "field",
  };
}

function reposOf(
  root: string,
  file: string,
  workspace: Record<string, unknown>,
  errors: CollectionError[],
): WorkspaceRepo[] {
  const repos = workspace["repos"];
  if (repos === undefined) {
    return [];
  }
  return Object.entries(asRecord(repos, "repos"))
    .filter(([name]) => !name.startsWith("_"))
    .map(([name, value]): [string, Record<string, unknown>] => [name, asRecord(value, `repo ${name}`)])
    .filter(([, repo]) => repo["role"] !== "workspace")
    .map(([name, repo]) => {
      const path = repoPath(root, name, repo);
      const defaultBranch = defaultBranchIn(name, repo) ?? defaultBranchOf(path);
      if (defaultBranch === undefined) {
        const unread = unreadDefaultBranch(path, file);
        if (unread !== undefined) {
          errors.push(unread);
        }
      }
      return {
        name,
        path,
        kind: repoKind(repo["deploy"]),
        ...(defaultBranch !== undefined && { defaultBranch }),
      };
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
  const found = workspaceFile(dir);
  const name = found?.name ?? WORKSPACE_FILE;
  const file = found?.path ?? join(dir, WORKSPACE_FILE);
  const skeleton = {
    id: basename(dir),
    name: basename(dir),
    root: dir,
    metrics: {},
    ...(found && { workspaceFile: found.name }),
  };
  try {
    const workspace = asRecord(JSON.parse(readFileSync(file, "utf8")), name);
    const lockPrefix = lockPrefixOf(workspace);
    const unread: CollectionError[] = [];
    const repos = reposOf(dir, name, workspace, unread);
    const reading =
      lockPrefix === undefined
        ? { lanes: [], errors: [] }
        : readLanes(lockPrefix, {
            lockRoot: options.lockRoot,
            env: options.env,
            lanes: laneCountOf(workspace),
            repos: repos.map((repo) => repo.path),
          });
    return Project.parse({
      ...skeleton,
      authority: { kind: "beads", idPrefix: workspace["idPrefix"] },
      repos,
      lanes: reading.lanes,
      errors: [...unread, ...reading.errors],
    });
  } catch (cause) {
    return Project.parse({
      ...skeleton,
      authority: { kind: "beads" },
      errors: [collectionError(file, cause)],
    });
  }
}
