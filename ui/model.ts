import {
  Classification,
  isYours,
  type CollectionError,
  type Issue,
  type Lane,
  type Project,
  type Snapshot,
  type StalenessVerdict,
} from "@404sl/pitwall-schema";

export type NeedsYouKind = "decision" | "access";
export type RunningState = "working" | "awaiting-lander" | "stranded";
export type ProblemScope = "run" | "console" | "project";

export interface NeedsYouRow {
  id: string;
  priority?: number;
  kind: NeedsYouKind;
  title: string;
  verdict: StalenessVerdict;
  checkedAt?: string;
}

export interface ReadyRow {
  project: string;
  id: string;
  priority?: number;
  title: string;
}

export interface LaneChip {
  id?: string;
  slot: number;
  elapsedMs?: number;
}

export interface RunningRow {
  project: string;
  state: RunningState;
  count: number;
  chips: LaneChip[];
}

export interface RunningTotal {
  state: RunningState;
  count: number;
}

export interface NeedsYouGroup {
  project: string;
  rows: NeedsYouRow[];
}

export interface ParkedEntry {
  reason: string;
  count: number;
}

export interface ProblemRow {
  scope: ProblemScope;
  name: string;
  source: string;
  message: string;
  at: string;
}

export interface Board {
  generatedAt: string;
  projectCount: number;
  needsYou: NeedsYouGroup[];
  needsYouCount: number;
  running: RunningRow[];
  runningTotals: RunningTotal[];
  ready: ReadyRow[];
  readyCount: number;
  readyShown: number;
  parked: ParkedEntry[];
  problems: ProblemRow[];
}

export const READY_LIMIT = 8;
export const LANE_CHIP_LIMIT = 3;

const RUNNING_ORDER: RunningState[] = ["working", "awaiting-lander", "stranded"];

const RUNNING_FROM_CLASSIFICATION: Partial<Record<string, RunningState>> = {
  "in-flight": "working",
  landing: "awaiting-lander",
};

const RUNNING_FROM_LANE: Partial<Record<string, RunningState>> = {
  working: "working",
  "handed-off": "awaiting-lander",
  stranded: "stranded",
};

function issuesOf(project: Project): Issue[] {
  return project.issues ?? [];
}

function lanesOf(project: Project): Lane[] {
  return project.lanes ?? [];
}

function errorsOf(source: { errors?: CollectionError[] }): CollectionError[] {
  return source.errors ?? [];
}

function byPriorityThenId(a: { priority?: number; id: string }, b: { priority?: number; id: string }): number {
  const left = a.priority ?? Number.MAX_SAFE_INTEGER;
  const right = b.priority ?? Number.MAX_SAFE_INTEGER;
  if (left !== right) {
    return left - right;
  }
  return a.id.localeCompare(b.id);
}

function byCountThenName(a: { count: number; name: string }, b: { count: number; name: string }): number {
  if (a.count !== b.count) {
    return b.count - a.count;
  }
  return a.name.localeCompare(b.name);
}

function verdictOf(issue: Issue): StalenessVerdict {
  return issue.staleness?.verdict ?? "unchecked";
}

function kindOf(issue: Issue): NeedsYouKind {
  return issue.classification === "yours:decision" ? "decision" : "access";
}

function elapsedMs(generatedAt: string, lastActivityAt: string | undefined): number | undefined {
  if (lastActivityAt === undefined) {
    return undefined;
  }
  const from = Date.parse(lastActivityAt);
  const to = Date.parse(generatedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return undefined;
  }
  return Math.max(0, to - from);
}

function byElapsedDescending(a: LaneChip, b: LaneChip): number {
  const left = a.elapsedMs ?? -1;
  const right = b.elapsedMs ?? -1;
  if (left !== right) {
    return right - left;
  }
  return a.slot - b.slot;
}

function chipsFor(project: Project, generatedAt: string, state: RunningState): LaneChip[] {
  return lanesOf(project)
    .filter((lane) => RUNNING_FROM_LANE[lane.state] === state)
    .map((lane) => ({
      id: lane.issueId,
      slot: lane.slot,
      elapsedMs: elapsedMs(generatedAt, lane.lastActivityAt),
    }))
    .sort(byElapsedDescending);
}

function needsYouGroups(projects: Project[]): NeedsYouGroup[] {
  return projects
    .map((project) => ({
      project: project.name,
      rows: issuesOf(project)
        .filter((issue) => isYours(issue.classification))
        .map((issue) => ({
          id: issue.id,
          priority: issue.priority,
          kind: kindOf(issue),
          title: issue.title,
          verdict: verdictOf(issue),
          checkedAt: issue.staleness?.checkedAt,
        }))
        .sort(byPriorityThenId),
    }))
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => byCountThenName({ count: a.rows.length, name: a.project }, { count: b.rows.length, name: b.project }));
}

function runningRows(projects: Project[], generatedAt: string): RunningRow[] {
  const groups = projects.map((project) => {
    const rows = RUNNING_ORDER.map((state) => {
      const fromIssues = issuesOf(project).filter(
        (issue) => RUNNING_FROM_CLASSIFICATION[issue.classification] === state,
      ).length;
      const chips = chipsFor(project, generatedAt, state);
      const count = state === "stranded" ? chips.length : Math.max(fromIssues, chips.length);
      return { project: project.name, state, count, chips };
    }).filter((row) => row.count > 0);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return { name: project.name, count: total, rows };
  });
  return groups
    .filter((group) => group.rows.length > 0)
    .sort(byCountThenName)
    .flatMap((group) => group.rows);
}

function runningTotals(rows: RunningRow[]): RunningTotal[] {
  return RUNNING_ORDER.map((state) => ({
    state,
    count: rows.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0),
  })).filter((total) => total.count > 0);
}

function readyRows(projects: Project[]): ReadyRow[] {
  return projects
    .map((project) => ({
      name: project.name,
      rows: issuesOf(project)
        .filter((issue) => issue.classification === "ready")
        .map((issue) => ({ project: project.name, id: issue.id, priority: issue.priority, title: issue.title }))
        .sort(byPriorityThenId),
    }))
    .filter((group) => group.rows.length > 0)
    .map((group) => ({ ...group, count: group.rows.length }))
    .sort(byCountThenName)
    .flatMap((group) => group.rows);
}

export function parkedReasons(): string[] {
  const parked = Classification.options
    .filter((option) => option.startsWith("parked:"))
    .map((option) => option.slice("parked:".length));
  return [...parked, "blocked"];
}

function parkedEntries(projects: Project[]): ParkedEntry[] {
  const counts = new Map<string, number>();
  for (const project of projects) {
    for (const issue of issuesOf(project)) {
      const reason = issue.classification === "blocked" ? "blocked" : undefined;
      const parked = issue.classification.startsWith("parked:")
        ? issue.classification.slice("parked:".length)
        : reason;
      if (parked === undefined) {
        continue;
      }
      counts.set(parked, (counts.get(parked) ?? 0) + 1);
    }
  }
  return parkedReasons()
    .map((reason) => ({ reason, count: counts.get(reason) ?? 0 }))
    .filter((entry) => entry.count > 0);
}

export function parkedSummary(entries: ParkedEntry[]): string {
  return entries
    .filter((entry) => entry.reason !== "blocked")
    .map((entry) => `${entry.reason} ${entry.count}`)
    .join(" \u00b7 ");
}

export function blockedSummary(entries: ParkedEntry[]): string {
  const blocked = entries.find((entry) => entry.reason === "blocked");
  return blocked === undefined ? "" : `blocked ${blocked.count}`;
}

function problemRows(snapshot: Snapshot): ProblemRow[] {
  const run: ProblemRow[] = errorsOf(snapshot).map((error) => ({
    scope: "run" as const,
    name: "run",
    source: error.source,
    message: error.message,
    at: error.at,
  }));
  const projects: ProblemRow[] = (snapshot.projects ?? []).flatMap((project) =>
    errorsOf(project).map((error) => ({
      scope: "project" as const,
      name: project.name,
      source: error.source,
      message: error.message,
      at: error.at,
    })),
  );
  return [...run, ...projects];
}

export function buildBoard(snapshot: Snapshot): Board {
  const projects = snapshot.projects ?? [];
  const generatedAt = snapshot.generatedAt;
  const needsYou = needsYouGroups(projects);
  const running = runningRows(projects, generatedAt);
  const ready = readyRows(projects);
  return {
    generatedAt,
    projectCount: projects.length,
    needsYou,
    needsYouCount: needsYou.reduce((sum, group) => sum + group.rows.length, 0),
    running,
    runningTotals: runningTotals(running),
    ready: ready.slice(0, READY_LIMIT),
    readyCount: ready.length,
    readyShown: Math.min(ready.length, READY_LIMIT),
    parked: parkedEntries(projects),
    problems: problemRows(snapshot),
  };
}
