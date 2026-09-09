import {
  Project,
  SCHEMA_VERSION,
  isYours,
  parseSnapshot,
  type CollectionError,
  type Issue,
  type Metrics,
  type Snapshot,
} from "@404sl/pitwall-schema";
import { noteAppender, readIssues, type ClosedIssue, type IssueText } from "./beads.js";
import { recordOnce } from "./errors.js";
import { hasLiveStructuralBlocker, type ClassifyContext } from "./classify.js";
import { collectProjects, historyLimits, type RootsOptions } from "./config.js";
import { recordSnapshot, type HistoryMetrics } from "./history.js";
import { deliver, noticesFor, type Delivered, type Noter, type Sender } from "./notify.js";
import { issueMatcher, readPipeline } from "./pipeline.js";
import { preconditionProbe, pullLookup } from "./probes.js";
import { readSnapshot, writeSnapshot } from "./state.js";
import { assess, isAssessable, type StalenessContext } from "./staleness.js";
import { VERSION } from "./version.js";

export interface SnapshotOptions extends RootsOptions {
  timeoutMs?: number;
  now?: Date;
  pullFacts?: StalenessContext["pullFacts"];
  probe?: StalenessContext["probe"];
  sender?: Sender;
  sessionRef?: string;
  note?: Noter;
}

export interface SnapshotResult {
  snapshot: Snapshot;
  path: string | undefined;
  code: number;
  read: boolean;
  delivered: Delivered[];
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
  errors: CollectionError[],
): StalenessContext {
  const repos = new Map(project.repos.map((repo) => [repo.name, repo.path]));
  const knownIds = new Set([...collected.issues, ...collected.closed].map((issue) => issue.id));
  return {
    idPrefix: project.authority.idPrefix,
    knownIds,
    closedIds: new Set(collected.closed.map((issue) => issue.id)),
    pullFacts:
      options.pullFacts ??
      (repos.size === 0
        ? undefined
        : pullLookup({
            repos,
            names: issueMatcher(project.authority.idPrefix, knownIds),
            env: options.env,
            timeoutMs: options.timeoutMs,
            errors,
          })),
    probe:
      options.probe ??
      preconditionProbe({ env: options.env, timeoutMs: options.timeoutMs, errors }),
    now: day,
  };
}

interface Assessed {
  issue: Issue;
  errors: readonly CollectionError[];
}

async function assessed(
  issue: Issue,
  texts: ReadonlyMap<string, IssueText>,
  context: StalenessContext,
  structure: ClassifyContext,
): Promise<Assessed> {
  if (!isAssessable(issue.classification)) {
    return { issue, errors: [] };
  }
  const text = texts.get(issue.id);
  const assessment = await assess(
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
  );
  return { issue: { ...issue, staleness: assessment.staleness }, errors: assessment.errors };
}

interface Gathered {
  project: Project;
  closed: readonly ClosedIssue[];
  unreadable: boolean;
}

async function gather(project: Project, options: SnapshotOptions, day: Date): Promise<Gathered> {
  const collected = await readIssues(project.root, {
    env: options.env,
    lanes: project.lanes,
    errors: project.errors,
    timeoutMs: options.timeoutMs,
  });
  const unchecked: CollectionError[] = [];
  const context = stalenessContext(project, collected, options, day, unchecked);
  const structure: ClassifyContext = {
    issues: [...collected.issues, ...collected.closed],
    lanes: project.lanes,
    collectionComplete: project.errors.length === 0,
  };
  const assessments = await Promise.all(
    collected.issues.map((issue) => assessed(issue, collected.texts, context, structure)),
  );
  const issues = assessments.map((entry) => entry.issue);
  const unassessable: CollectionError[] = [];
  for (const entry of assessments) {
    for (const error of entry.errors) {
      recordOnce(unassessable, error);
    }
  }
  const pipeline = await readPipeline(project, {
    env: options.env,
    timeoutMs: options.timeoutMs,
    knownIds: context.knownIds,
  });
  return {
    closed: collected.closed,
    project: Project.parse({
      ...project,
      issues,
      pipeline: pipeline.pipeline,
      metrics: metricsOf(issues, collected.closed, day),
      errors: [
        ...project.errors,
        ...collected.errors,
        ...pipeline.errors,
        ...unchecked,
        ...unassessable,
      ],
    }),
    unreadable: project.errors.length > 0 || collected.errors.length > 0,
  };
}

function readSomething(gathered: readonly Gathered[]): boolean {
  return gathered.some((entry) => !entry.unreadable);
}

function everyProjectFailed(gathered: readonly Gathered[]): boolean {
  return gathered.length > 0 && !readSomething(gathered);
}

interface Assembled {
  snapshot: Snapshot;
  code: number;
  gathered: Gathered[];
}

async function assemble(options: SnapshotOptions): Promise<Assembled> {
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
    gathered,
  };
}

async function announce(
  gathered: readonly Gathered[],
  previous: Snapshot | undefined,
  options: SnapshotOptions,
): Promise<Delivered[]> {
  const sender = options.sender;
  if (sender === undefined) {
    return [];
  }
  const delivered: Delivered[] = [];
  for (const entry of gathered) {
    const notices = noticesFor({
      previous: previous?.projects.find((project) => project.id === entry.project.id),
      issues: entry.project.issues,
      closed: entry.closed,
      sessionRef: options.sessionRef,
    });
    if (notices.length === 0) {
      continue;
    }
    const note =
      options.note ??
      noteAppender(entry.project.root, { env: options.env, timeoutMs: options.timeoutMs });
    delivered.push(...(await deliver(notices, { sender, note })));
  }
  return delivered;
}

export async function collectSnapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
  return (await assemble(options)).snapshot;
}

function withHistory(project: Project, derived: HistoryMetrics | undefined): Project {
  if (derived === undefined) {
    return project;
  }
  const metrics: Metrics = { ...project.metrics, landedToday: derived.landedToday };
  if (derived.medianTimeToLandMinutes !== undefined) {
    metrics.medianTimeToLandMinutes = derived.medianTimeToLandMinutes;
  }
  if (derived.bounceRate !== undefined) {
    metrics.bounceRate = derived.bounceRate;
  }
  return { ...project, metrics };
}

export async function emitSnapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const previous = readSnapshot(options).snapshot;
  const { snapshot, code, gathered } = await assemble(options);
  if (!readSomething(gathered)) {
    return { snapshot, path: undefined, code, read: false, delivered: [] };
  }
  const history = await recordSnapshot(snapshot, {
    env: options.env,
    home: options.home,
    limits: historyLimits(options),
    now: new Date(snapshot.generatedAt),
  });
  const recorded = parseSnapshot({
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      withHistory(project, history.metrics.get(project.id)),
    ),
    errors: history.error === undefined ? snapshot.errors : [...snapshot.errors, history.error],
  });
  const path = writeSnapshot(recorded, options);
  return {
    snapshot: recorded,
    path,
    code,
    read: true,
    delivered: await announce(gathered, previous, options),
  };
}
