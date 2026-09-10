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
import { KEPT_SOURCE, PARTIAL_SOURCE } from "./board.js";
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

type GatheredMetrics = Pick<Metrics, "readyCount" | "inboxCount" | "closedToday" | "landedToday">;

const NAMES_A_MERGE = /\b(merged|landed)\b/i;

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

function landedCount(closedToday: readonly ClosedIssue[], readable: boolean): number | undefined {
  if (!readable || closedToday.some((issue) => issue.closeReason === undefined)) {
    return undefined;
  }
  return closedToday.filter((issue) => NAMES_A_MERGE.test(issue.closeReason ?? "")).length;
}

function metricsOf(
  issues: readonly Issue[],
  closed: readonly ClosedIssue[],
  day: Date,
  readable: boolean,
): GatheredMetrics {
  const today = closed.filter((issue) => closedOn(issue.closedAt ?? issue.updatedAt, day));
  return {
    readyCount: issues.filter((issue) => issue.classification === "ready").length,
    inboxCount: issues.filter((issue) => isYours(issue.classification)).length,
    closedToday: today.length,
    landedToday: landedCount(today, readable),
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
  issuesRead: boolean;
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
  const unreadable = project.errors.length > 0 || collected.errors.length > 0;
  return {
    closed: collected.closed,
    project: Project.parse({
      ...project,
      issues,
      pipeline: pipeline.pipeline,
      metrics: metricsOf(issues, collected.closed, day, !unreadable),
      errors: [
        ...project.errors,
        ...collected.errors,
        ...pipeline.errors,
        ...unchecked,
        ...unassessable,
      ],
    }),
    unreadable,
    issuesRead: collected.errors.length === 0,
  };
}

function keptAt(held: Project, fallback: string): string {
  return held.errors.find((error) => error.source === KEPT_SOURCE)?.at ?? fallback;
}

function keeping(project: Project, held: Project, at: string, day: Date): Project {
  return Project.parse({
    ...project,
    issues: held.issues,
    metrics: { ...project.metrics, ...metricsOf(held.issues, [], day, false) },
    errors: [
      ...project.errors,
      {
        source: KEPT_SOURCE,
        message: `${held.issues.length} issues kept from the last collection that could read this project.`,
        at,
      },
    ],
  });
}

type Fate = "kept" | "missing";

const FATES: Record<Fate, string> = {
  kept: "issues kept from the last snapshot",
  missing: "issues missing from this board",
};

interface Fated {
  name: string;
  fate: Fate;
}

function partialCollection(fated: readonly Fated[], total: number, at: string): CollectionError {
  const named = fated.map((entry) => `${entry.name} (${FATES[entry.fate]})`).join(", ");
  return {
    source: PARTIAL_SOURCE,
    message: `${fated.length} of ${total} projects could not be read: ${named}.`,
    at,
  };
}

function keptBoard(
  snapshot: Snapshot,
  previous: Snapshot | undefined,
  gathered: readonly Gathered[],
): Snapshot {
  const unread = new Set(
    gathered.filter((entry) => !entry.issuesRead).map((entry) => entry.project.id),
  );
  if (unread.size === 0) {
    return snapshot;
  }
  const day = new Date(snapshot.generatedAt);
  const held = new Map((previous?.projects ?? []).map((project) => [project.id, project]));
  const fated: Fated[] = [];
  const projects = snapshot.projects.map((project) => {
    if (!unread.has(project.id)) {
      return project;
    }
    const before = held.get(project.id);
    if (before === undefined || before.issues.length === 0) {
      fated.push({ name: project.name, fate: "missing" });
      return project;
    }
    fated.push({ name: project.name, fate: "kept" });
    const at = keptAt(before, previous?.generatedAt ?? snapshot.generatedAt);
    return keeping(project, before, at, day);
  });
  return parseSnapshot({
    ...snapshot,
    projects,
    errors: [
      ...snapshot.errors,
      partialCollection(fated, snapshot.projects.length, snapshot.generatedAt),
    ],
  });
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
  const metrics: Metrics = { ...project.metrics };
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
  const written = keptBoard(recorded, previous, gathered);
  const path = writeSnapshot(written, options);
  return {
    snapshot: written,
    path,
    code,
    read: true,
    delivered: await announce(gathered, previous, options),
  };
}
