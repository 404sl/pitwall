import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Project, type CollectionError, type RepoKind } from "@404sl/pitwall-schema";

export const AUTOFIX_FILE = ".autofix.json";

export function collectionError(source: string, cause: unknown): CollectionError {
  return {
    source,
    message: cause instanceof Error ? cause.message : String(cause),
    at: new Date().toISOString(),
  };
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

export function readWorkspace(root: string): Project {
  const dir = resolve(root);
  const file = join(dir, AUTOFIX_FILE);
  const skeleton = { id: basename(dir), name: basename(dir), root: dir, metrics: {} };
  try {
    const workspace = asRecord(JSON.parse(readFileSync(file, "utf8")), AUTOFIX_FILE);
    return Project.parse({
      ...skeleton,
      authority: { kind: "beads", idPrefix: workspace["idPrefix"] },
      repos: reposOf(dir, workspace),
    });
  } catch (cause) {
    return Project.parse({
      ...skeleton,
      authority: { kind: "beads" },
      errors: [collectionError(file, cause)],
    });
  }
}
