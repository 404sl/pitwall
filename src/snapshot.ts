import {
  Project,
  SCHEMA_VERSION,
  isYours,
  parseSnapshot,
  type Issue,
  type Metrics,
  type Snapshot,
} from "@404sl/pitwall-schema";
import { readIssues, type ClosedIssue } from "./beads.js";
import { collectProjects, type RootsOptions } from "./config.js";
import { writeSnapshot } from "./state.js";
import { VERSION } from "./version.js";

export interface SnapshotOptions extends RootsOptions {
  timeoutMs?: number;
  now?: Date;
}

export interface SnapshotResult {
  snapshot: Snapshot;
  path: string;
  code: number;
}

type GatheredMetrics = Pick<Metrics, "readyCount" | "inboxCount" | "closedToday">;

function closedOn(at: string | undefined, day: Date): boolean {
  if (at === undefined) {
    return false;
  }
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) {
    return false;
  }
  return (
    when.getFullYear() === day.getFullYear() &&
    when.getMonth() === day.getMonth() &&
    when.getDate() === day.getDate()
  );
}

function metricsOf(
  issues: readonly Issue[],
  closed: readonly ClosedIssue[],
  day: Date,
): GatheredMetrics {
  return {
    readyCount: issues.filter((issue) => issue.classification === "ready").length,
    inboxCount: issues.filter((issue) => isYours(issue.classification)).length,
    closedToday: closed.filter((issue) => closedOn(issue.closedAt ?? issue.updatedAt, day)).length,
  };
}

async function gather(project: Project, options: SnapshotOptions, day: Date): Promise<Project> {
  const collected = await readIssues(project.root, {
    env: options.env,
    lanes: project.lanes,
    errors: project.errors,
    timeoutMs: options.timeoutMs,
  });
  return Project.parse({
    ...project,
    issues: collected.issues,
    metrics: metricsOf(collected.issues, collected.closed, day),
    errors: [...project.errors, ...collected.errors],
  });
}

export async function collectSnapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
  const startedAt = options.now ?? new Date();
  const { projects, roots } = collectProjects(options);
  const gathered = await Promise.all(projects.map((project) => gather(project, options, startedAt)));
  return parseSnapshot({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: startedAt.toISOString(),
    agent: { version: VERSION },
    projects: gathered,
    errors: roots.errors,
  });
}

function everyProjectFailed(snapshot: Snapshot): boolean {
  return (
    snapshot.projects.length > 0 &&
    snapshot.projects.every((project) => project.errors.length > 0)
  );
}

export async function emitSnapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const snapshot = await collectSnapshot(options);
  return {
    snapshot,
    path: writeSnapshot(snapshot, options),
    code: everyProjectFailed(snapshot) ? 1 : 0,
  };
}
