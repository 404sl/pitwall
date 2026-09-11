import {
  Classification,
  isYours,
  type Authority,
  type Classification as ClassificationValue,
  type CollectionError,
  type Issue,
  type Lane,
  type Origin,
  type Project,
  type Snapshot,
  type Staleness,
  type StalenessVerdict,
} from "@404sl/pitwall-schema";
import { parentIdOf, type ClassificationReason } from "./classify.js";
import { priorityLabel } from "./format.js";
import {
  STALENESS_SOURCE,
  UNRESOLVED_KINDS,
  stalenessSource,
  unresolvedOf,
  type Unresolved,
  type UnresolvedKind,
} from "./staleness.js";

export type NeedsYouKind = "decision" | "access";
export type RunningState = "working" | "awaiting-lander" | "stranded";
export type ProblemScope = "run" | "console" | "project";

export const REFRESH_SOURCE = "pitwall serve: re-collection";
export const NOTICE_SOURCE = "pitwall serve: outbound notice";
export const PARTIAL_SOURCE = "pitwall snapshot: partial collection";
export const KEPT_SOURCE = "pitwall snapshot: kept from the last readable collection";

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
  projectId: string;
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
  projectId: string;
  state: RunningState;
  count: number;
  total?: number;
  chips: LaneChip[];
}

export interface RunningTotal {
  state: RunningState;
  count: number;
}

export interface NeedsYouGroup {
  project: string;
  projectId: string;
  rows: NeedsYouRow[];
}

export interface ReadyGroup {
  project: string;
  rows: ReadyRow[];
  total: number;
}

export interface ParkedEntry {
  reason: string;
  count: number;
}

export interface ParkedCount {
  reason: string;
  count: number;
  total?: number;
}

export interface ProblemRow {
  scope: ProblemScope;
  name: string;
  source: string;
  message: string;
  at: string;
}

export function problemKey(row: ProblemRow): string {
  return [row.scope, row.name, row.source, row.at, row.message].join("\u0000");
}

export type ProblemEntry =
  | { kind: "rows"; key: string; rows: ProblemRow[] }
  | { kind: "group"; key: string; source: string; cause: UnresolvedKind; rows: ProblemRow[]; at: string };

function sharedCause(row: ProblemRow): UnresolvedKind | undefined {
  if (row.scope === "console" || !row.source.startsWith(`${STALENESS_SOURCE} `)) {
    return undefined;
  }
  return unresolvedOf(row.message)?.kind;
}

function looseEntry(rows: readonly ProblemRow[]): ProblemEntry[] {
  const [first] = rows;
  return first === undefined ? [] : [{ kind: "rows", key: problemKey(first), rows: [...rows] }];
}

function newest(rows: readonly ProblemRow[]): string {
  return rows.reduce((latest, row) => (row.at > latest ? row.at : latest), "");
}

export function problemGroups(rows: readonly ProblemRow[]): ProblemEntry[] {
  const shared = new Map<UnresolvedKind, ProblemRow[]>();
  for (const row of rows) {
    const cause = sharedCause(row);
    if (cause === undefined) {
      continue;
    }
    const held = shared.get(cause);
    if (held === undefined) {
      shared.set(cause, [row]);
    } else {
      held.push(row);
    }
  }
  const entries: ProblemEntry[] = [];
  const loose: ProblemRow[] = [];
  const placed = new Set<UnresolvedKind>();
  for (const row of rows) {
    const cause = sharedCause(row);
    const held = cause === undefined ? undefined : shared.get(cause);
    if (cause === undefined || held === undefined || held.length < 2) {
      loose.push(row);
      continue;
    }
    if (placed.has(cause)) {
      continue;
    }
    placed.add(cause);
    entries.push(...looseEntry(loose));
    loose.length = 0;
    entries.push({
      kind: "group",
      key: `${STALENESS_SOURCE}-${cause}`,
      source: STALENESS_SOURCE,
      cause,
      rows: held,
      at: newest(held),
    });
  }
  entries.push(...looseEntry(loose));
  return entries;
}

export const FILTER_NONE = "none";

export const FILTER_KEYS = ["project", "type", "priority", "epic"] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

export type FilterState = Partial<Record<FilterKey, string>>;

export interface FilterOption {
  value: string;
  label: string;
}

export type FilterOptions = Record<FilterKey, FilterOption[]>;

export interface BoardTotals {
  needsYou: number;
  running: number;
  runningStates: RunningTotal[];
  ready: number;
  parked: ParkedEntry[];
  issues: number;
}

export interface TodayTotals {
  landed: number | undefined;
  closed: number;
}

export interface Board {
  generatedAt: string;
  projectCount: number;
  needsYou: NeedsYouGroup[];
  needsYouCount: number;
  running: RunningRow[];
  runningTotals: RunningTotal[];
  runningCount: number;
  ready: ReadyRow[];
  readyCount: number;
  readyShown: number;
  parked: ParkedEntry[];
  problems: ProblemRow[];
  filter: FilterState;
  filtered: boolean;
  options: FilterOptions;
  issueCount: number;
  today: TodayTotals;
  totals: BoardTotals;
  refreshFailure?: CollectionError;
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
      projectId: project.id,
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

function claimedBy(project: Project): Set<string> {
  return new Set(
    lanesOf(project).flatMap((lane) =>
      RUNNING_FROM_LANE[lane.state] !== undefined && lane.issueId !== undefined ? [lane.issueId] : [],
    ),
  );
}

function carriesKept(project: Project): boolean {
  return errorsOf(project).some((error) => error.source === KEPT_SOURCE);
}

function runningRows(projects: Project[], generatedAt: string): RunningRow[] {
  const groups = projects.filter((project) => !carriesKept(project)).map((project) => {
    const claimed = claimedBy(project);
    const rows = RUNNING_ORDER.map((state) => {
      const unclaimed = issuesOf(project).filter(
        (issue) => RUNNING_FROM_CLASSIFICATION[issue.classification] === state && !claimed.has(issue.id),
      ).length;
      const chips = chipsFor(project, generatedAt, state);
      const count = chips.length + unclaimed;
      return { project: project.name, projectId: project.id, state, count, chips };
    }).filter((row) => row.count > 0);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return { name: project.name, count: total, rows };
  });
  return groups
    .filter((group) => group.rows.length > 0)
    .sort(byCountThenName)
    .flatMap((group) => group.rows);
}

function runningKey(row: { projectId: string; state: RunningState }): string {
  return `${row.projectId}\u0000${row.state}`;
}

function withRunningTotals(rows: RunningRow[], unfiltered: RunningRow[]): RunningRow[] {
  const totals = new Map(unfiltered.map((row) => [runningKey(row), row.count]));
  return rows.map((row) => ({ ...row, total: totals.get(runningKey(row)) ?? row.count }));
}

function runningTotals(rows: RunningRow[]): RunningTotal[] {
  return RUNNING_ORDER.map((state) => ({
    state,
    count: rows.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0),
  })).filter((total) => total.count > 0);
}

function readyGroups(projects: Project[]): ReadyGroup[] {
  return projects
    .map((project) => ({
      name: project.name,
      rows: issuesOf(project)
        .filter((issue) => issue.classification === "ready")
        .map((issue) => ({
          project: project.name,
          projectId: project.id,
          id: issue.id,
          priority: issue.priority,
          title: issue.title,
        }))
        .sort(byPriorityThenId),
    }))
    .filter((group) => group.rows.length > 0)
    .map((group) => ({ ...group, count: group.rows.length }))
    .sort(byCountThenName)
    .map((group) => ({ project: group.name, rows: group.rows, total: group.count }));
}

function readyRows(projects: Project[]): ReadyRow[] {
  return readyGroups(projects).flatMap((group) => group.rows);
}

export function readyByProject(snapshot: Snapshot, limit: number): ReadyGroup[] {
  return readyGroups(snapshot.projects ?? []).map((group) => ({ ...group, rows: group.rows.slice(0, limit) }));
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

export function parkedCounts(entries: ParkedEntry[], totals?: ParkedEntry[]): ParkedCount[] {
  if (totals === undefined) {
    return entries.map((entry) => ({ reason: entry.reason, count: entry.count }));
  }
  const shown = new Map(entries.map((entry) => [entry.reason, entry.count]));
  return totals.map((entry) => ({ reason: entry.reason, count: shown.get(entry.reason) ?? 0, total: entry.count }));
}

export function countOf(part: ParkedCount): string {
  return part.total === undefined ? String(part.count) : `${part.count} of ${part.total}`;
}

export function parkedSummary(entries: ParkedEntry[], totals?: ParkedEntry[]): string {
  return parkedCounts(entries, totals)
    .filter((part) => part.reason !== "blocked")
    .map((part) => `${part.reason} ${countOf(part)}`)
    .join(" \u00b7 ");
}

export function blockedSummary(entries: ParkedEntry[], totals?: ParkedEntry[]): string {
  const blocked = parkedCounts(entries, totals).find((part) => part.reason === "blocked");
  return blocked === undefined ? "" : `blocked ${countOf(blocked)}`;
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

export function refreshFailure(snapshot: Snapshot): CollectionError | undefined {
  const errors = errorsOf(snapshot);
  return (
    errors.find((error) => error.source === REFRESH_SOURCE) ??
    errors.find((error) => error.source === PARTIAL_SOURCE)
  );
}

export const ISSUE_TYPES = ["bug", "feature", "task", "chore", "epic", "decision"];

export const PRIORITIES = [0, 1, 2, 3, 4];

export const epicOf = parentIdOf;

export function isFiltered(filter: FilterState): boolean {
  return FILTER_KEYS.some((key) => filter[key] !== undefined);
}

interface Filterable {
  id: string;
  issueType?: string;
  priority?: number;
}

function matchesValue(value: string | undefined, actual: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  return value === FILTER_NONE ? actual === undefined : value === actual;
}

function issueMatches(projectId: string, issue: Filterable, filter: FilterState): boolean {
  if (filter.project !== undefined && filter.project !== projectId) {
    return false;
  }
  if (!matchesValue(filter.type, issue.issueType)) {
    return false;
  }
  if (!matchesValue(filter.priority, issue.priority === undefined ? undefined : String(issue.priority))) {
    return false;
  }
  if (filter.epic === undefined) {
    return true;
  }
  return filter.epic === FILTER_NONE
    ? epicOf(issue.id) === undefined
    : issue.id.startsWith(`${filter.epic}.`);
}

const UNRESOLVED_LANE: Filterable = { id: "" };

function laneMatches(project: Project, lane: Lane, filter: FilterState): boolean {
  const issue = lane.issueId === undefined ? undefined : issuesOf(project).find((entry) => entry.id === lane.issueId);
  return issueMatches(project.id, issue ?? UNRESOLVED_LANE, filter);
}

function filteredProjects(projects: Project[], filter: FilterState): Project[] {
  if (!isFiltered(filter)) {
    return projects;
  }
  return projects.map((project) => ({
    ...project,
    issues: issuesOf(project).filter((issue) => issueMatches(project.id, issue, filter)),
    lanes: lanesOf(project).filter((lane) => laneMatches(project, lane, filter)),
  }));
}

function filterOptions(projects: Project[]): FilterOptions {
  const issues = projects.flatMap(issuesOf);
  const extraTypes = [
    ...new Set(
      issues
        .map((issue) => issue.issueType)
        .filter((type): type is string => type !== undefined && !ISSUE_TYPES.includes(type)),
    ),
  ].sort();
  const epics = [...new Set(issues.map((issue) => epicOf(issue.id)).filter((id): id is string => id !== undefined))].sort();
  return {
    project: projects.map((project) => ({ value: project.id, label: project.name })),
    type: [...ISSUE_TYPES, ...extraTypes].map((type) => ({ value: type, label: type })),
    priority: PRIORITIES.map((priority) => ({ value: String(priority), label: priorityLabel(priority) })),
    epic: epics.map((id) => ({ value: id, label: id })),
  };
}

function todayTotals(projects: Project[]): TodayTotals {
  const metrics = projects.map((project) => project.metrics ?? {});
  const landed = metrics.map((entry) => entry.landedToday);
  const counted = landed.filter((count): count is number => count !== undefined);
  return {
    landed:
      landed.length > 0 && counted.length === landed.length
        ? counted.reduce((sum, count) => sum + count, 0)
        : undefined,
    closed: metrics.reduce((sum, entry) => sum + (entry.closedToday ?? 0), 0),
  };
}

function boardTotals(projects: Project[], generatedAt: string, running: RunningRow[]): BoardTotals {
  return {
    needsYou: needsYouGroups(projects).reduce((sum, group) => sum + group.rows.length, 0),
    running: running.reduce((sum, row) => sum + row.count, 0),
    runningStates: runningTotals(running),
    ready: readyRows(projects).length,
    parked: parkedEntries(projects),
    issues: projects.reduce((sum, project) => sum + issuesOf(project).length, 0),
  };
}

export function buildBoard(snapshot: Snapshot, filter: FilterState = {}): Board {
  const projects = snapshot.projects ?? [];
  const generatedAt = snapshot.generatedAt;
  const shown = filteredProjects(projects, filter);
  const filtered = isFiltered(filter);
  const needsYou = needsYouGroups(shown);
  const everyRunning = runningRows(projects, generatedAt);
  const running = filtered ? withRunningTotals(runningRows(shown, generatedAt), everyRunning) : everyRunning;
  const ready = readyRows(shown);
  const parked = parkedEntries(shown);
  return {
    generatedAt,
    projectCount: projects.length,
    needsYou,
    needsYouCount: needsYou.reduce((sum, group) => sum + group.rows.length, 0),
    running,
    runningTotals: runningTotals(running),
    runningCount: running.reduce((sum, row) => sum + row.count, 0),
    ready: ready.slice(0, READY_LIMIT),
    readyCount: ready.length,
    readyShown: Math.min(ready.length, READY_LIMIT),
    parked,
    problems: problemRows(snapshot),
    filter,
    filtered,
    options: filterOptions(projects),
    issueCount: shown.reduce((sum, project) => sum + issuesOf(project).length, 0),
    today: todayTotals(projects),
    totals: boardTotals(projects, generatedAt, everyRunning),
    refreshFailure: refreshFailure(snapshot),
  };
}

export interface IssueLink {
  id: string;
  title: string;
  status: string;
}

export interface IssueBody {
  id: string;
  title: string;
  status: string;
  issueType?: string;
  priority?: number;
  labels: string[];
  project: string;
  projectName: string;
  authority: Authority;
  description?: string;
  notes?: string;
  blockedBy: IssueLink[];
  blocks: IssueLink[];
  origin?: Origin;
  classification?: ClassificationValue;
  reason: ClassificationReason;
  staleness: Staleness;
}

export interface IssuePayload {
  issue: IssueBody;
  readAt: string;
  snapshot?: { generatedAt: string; status: string };
  errors?: CollectionError[];
}

export interface StalenessView {
  verdict: StalenessVerdict;
  checked: boolean;
  checkedAt?: string;
  evidence: string[];
  unresolved: Unresolved[];
}

export interface IssuePreview {
  id: string;
  title: string;
  status: string;
  issueType?: string;
  priority?: number;
  labels: string[];
  project: string;
  projectName: string;
  classification?: ClassificationValue;
  closed: boolean;
  staleness: StalenessView;
}

export function stalenessErrors(source: { errors?: CollectionError[] }, id: string): CollectionError[] {
  return errorsOf(source).filter((error) => error.source === stalenessSource(id));
}

function unresolvedTally(errors: readonly CollectionError[]): Unresolved[] {
  const counts = new Map<UnresolvedKind, number>();
  for (const error of errors) {
    const named = unresolvedOf(error.message);
    if (named === undefined) {
      continue;
    }
    counts.set(named.kind, (counts.get(named.kind) ?? 0) + named.count);
  }
  return UNRESOLVED_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ kind, count }];
  });
}

function stalenessView(staleness: Staleness | undefined, errors: readonly CollectionError[]): StalenessView {
  const verdict = staleness?.verdict ?? "unchecked";
  return {
    verdict,
    checked: verdict !== "unchecked",
    checkedAt: staleness?.checkedAt,
    evidence: staleness?.evidence ?? [],
    unresolved: unresolvedTally(errors),
  };
}

export function previewIssue(snapshot: Snapshot, project: string, id: string): IssuePreview | undefined {
  const found = (snapshot.projects ?? []).find((entry) => entry.id === project);
  const issue = found === undefined ? undefined : issuesOf(found).find((entry) => entry.id === id);
  if (found === undefined || issue === undefined) {
    return undefined;
  }
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    issueType: issue.issueType,
    priority: issue.priority,
    labels: issue.labels,
    project: found.id,
    projectName: found.name,
    classification: issue.classification,
    closed: issue.status === "closed",
    staleness: stalenessView(issue.staleness, stalenessErrors(found, issue.id)),
  };
}

export interface IssueView {
  issue: IssueBody;
  readAt: string;
  snapshot?: { generatedAt: string; status: string };
  closed: boolean;
  closedSinceSnapshot: boolean;
  staleness: StalenessView;
}

export function buildIssueView(payload: IssuePayload): IssueView {
  return {
    issue: payload.issue,
    readAt: payload.readAt,
    snapshot: payload.snapshot,
    closed: payload.issue.status === "closed",
    closedSinceSnapshot:
      payload.snapshot !== undefined &&
      payload.snapshot.status !== "closed" &&
      payload.issue.status === "closed",
    staleness: stalenessView(payload.issue.staleness, payload.errors ?? []),
  };
}
