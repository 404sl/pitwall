import {
  Project,
  SCHEMA_VERSION,
  isYours,
  parseSnapshot,
  type Issue,
  type Metrics,
  type Snapshot,
} from "@404sl/pitwall-schema";
import { readIssues, type ClosedIssue, type IssueText } from "./beads.js";
import { hasLiveStructuralBlocker, type ClassifyContext } from "./classify.js";
import { collectProjects, type RootsOptions } from "./config.js";
import { readPipeline } from "./pipeline.js";
import { preconditionProbe, pullLookup } from "./probes.js";
import { writeSnapshot } from "./state.js";
import { assess, isAssessable, type StalenessContext } from "./staleness.js";
import { VERSION } from "./version.js";

export interface SnapshotOptions extends RootsOptions {
  timeoutMs?: number;
  now?: Date;
  pullState?: StalenessContext["pullState"];
  probe?: StalenessContext["probe"];
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

function stalenessContext(
  project: Project,
  collected: { issues: readonly Issue[]; closed: readonly ClosedIssue[] },
  options: SnapshotOptions,
  day: Date,
): StalenessContext {
  const repos = new Map(project.repos.map((repo) => [repo.name, repo.path]));
  return {
    idPrefix: project.authority.idPrefix,
    knownIds: new Set([...collected.issues, ...collected.closed].map((issue) => issue.id)),
    closedIds: new Set(collected.closed.map((issue) => issue.id)),
    pullState:
      options.pullState ??
      (repos.size === 0
        ? undefined
        : pullLookup({ repos, env: options.env, timeoutMs: options.timeoutMs })),
    probe: options.probe ?? preconditionProbe({ env: options.env, timeoutMs: options.timeoutMs }),
    now: day,
  };
}

async function assessed(
  issue: Issue,
  texts: ReadonlyMap<string, IssueText>,
  context: StalenessContext,
  structure: ClassifyContext,
): Promise<Issue> {
  if (!isAssessable(issue.classification)) {
    return issue;
  }
  const text = texts.get(issue.id);
  return {
    ...issue,
    staleness: await assess(
      {
        id: issue.id,
        title: issue.title,
        classification: issue.classification,
        labels: issue.labels,
        blockedBy: issue.blockedBy,
        structurallyBlocked: hasLiveStructuralBlocker(issue, structure),
        description: text?.description,
        notes: text?.notes,
      },
      context,
    ),
  };
}

interface Gathered {
  project: Project;
  unreadable: boolean;
}

async function gather(project: Project, options: SnapshotOptions, day: Date): Promise<Gathered> {
  const collected = await readIssues(project.root, {
    env: options.env,
    lanes: project.lanes,
    errors: project.errors,
    timeoutMs: options.timeoutMs,
  });
  const context = stalenessContext(project, collected, options, day);
  const structure: ClassifyContext = {
    issues: [...collected.issues, ...collected.closed],
    lanes: project.lanes,
    collectionComplete: project.errors.length === 0,
  };
  const issues = await Promise.all(
    collected.issues.map((issue) => assessed(issue, collected.texts, context, structure)),
  );
  const pipeline = await readPipeline(project, {
    env: options.env,
    timeoutMs: options.timeoutMs,
    knownIds: context.knownIds,
  });
  return {
    project: Project.parse({
      ...project,
      issues,
      pipeline: pipeline.pipeline,
      metrics: metricsOf(issues, collected.closed, day),
      errors: [...project.errors, ...collected.errors, ...pipeline.errors],
    }),
    unreadable: project.errors.length > 0 || collected.errors.length > 0,
  };
}

function everyProjectFailed(gathered: readonly Gathered[]): boolean {
  return gathered.length > 0 && gathered.every((entry) => entry.unreadable);
}

async function assemble(options: SnapshotOptions): Promise<{ snapshot: Snapshot; code: number }> {
  const startedAt = options.now ?? new Date();
  const { projects, roots } = collectProjects(options);
  const gathered = await Promise.all(projects.map((project) => gather(project, options, startedAt)));
  return {
    snapshot: parseSnapshot({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: startedAt.toISOString(),
      agent: { version: VERSION },
      projects: gathered.map((entry) => entry.project),
      errors: roots.errors,
    }),
    code: everyProjectFailed(gathered) ? 1 : 0,
  };
}

export async function collectSnapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
  return (await assemble(options)).snapshot;
}

export async function emitSnapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const { snapshot, code } = await assemble(options);
  return { snapshot, path: writeSnapshot(snapshot, options), code };
}
