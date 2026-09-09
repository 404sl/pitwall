import type { Classification, Issue, Lane } from "@404sl/pitwall-schema";

export type UnclassifiedIssue = Omit<Issue, "classification" | "staleness">;

export interface StoredClassification {
  classification: Classification;
  status: string;
}

export interface ClassifyContext {
  issues: readonly UnclassifiedIssue[];
  lanes: readonly Lane[];
  collectionComplete: boolean;
  stored?: ReadonlyMap<string, StoredClassification>;
  blockerStatus?: ReadonlyMap<string, string>;
  parentStatus?: string;
  childStatus?: ReadonlyMap<string, string>;
}

export type ClassificationReason =
  | { rule: "in-progress-lane"; slot: number }
  | { rule: "in-progress-no-lane" }
  | { rule: "label"; label: string }
  | { rule: "umbrella-type"; issueType: string }
  | { rule: "umbrella-title-marker" }
  | { rule: "umbrella-open-child"; childId: string }
  | { rule: "blocked-open"; ids: string[] }
  | { rule: "blocked-unreadable"; ids: string[] }
  | { rule: "blocked-parent-in-progress"; parentId: string }
  | { rule: "stored-status"; status: string }
  | { rule: "default" }
  | { rule: "closed" };

export interface Classified {
  classification: Classification | undefined;
  reason: ClassificationReason;
}

const PARKED_LABELS: ReadonlyArray<readonly [string, Classification]> = [
  ["blocked-tooling", "parked:tooling"],
  ["watch", "parked:watch"],
  ["umbrella", "parked:umbrella"],
  ["roadmap", "parked:roadmap"],
];

const EPIC_TITLE_MARKER = "[EPIC]";

function workingLane(issue: UnclassifiedIssue, lanes: readonly Lane[]): Lane | undefined {
  return lanes.find((lane) => lane.state === "working" && lane.issueId === issue.id);
}

function childStatusOf(issue: UnclassifiedIssue, context: ClassifyContext): Map<string, string> {
  const prefix = issue.id + ".";
  const children = new Map<string, string>();
  for (const other of context.issues) {
    if (other.id.startsWith(prefix)) children.set(other.id, other.status);
  }
  for (const [id, status] of context.childStatus ?? []) {
    if (id.startsWith(prefix)) children.set(id, status);
  }
  return children;
}

function umbrellaReason(
  issue: UnclassifiedIssue,
  context: ClassifyContext,
): ClassificationReason | undefined {
  if (issue.issueType === "epic") return { rule: "umbrella-type", issueType: issue.issueType };
  if (issue.title.includes(EPIC_TITLE_MARKER)) return { rule: "umbrella-title-marker" };
  for (const [childId, status] of childStatusOf(issue, context)) {
    if (status !== "closed") return { rule: "umbrella-open-child", childId };
  }
  return undefined;
}

export function isUmbrella(issue: UnclassifiedIssue, context: ClassifyContext): boolean {
  return umbrellaReason(issue, context) !== undefined;
}

export function parentIdOf(id: string): string | undefined {
  const cut = id.lastIndexOf(".");
  return cut === -1 ? undefined : id.slice(0, cut);
}

function blockedReason(
  issue: UnclassifiedIssue,
  context: ClassifyContext,
): ClassificationReason | undefined {
  const byId = new Map(context.issues.map((other) => [other.id, other]));
  const open: string[] = [];
  const unreadable: string[] = [];
  for (const id of issue.blockedBy) {
    const status = context.blockerStatus?.get(id) ?? byId.get(id)?.status;
    if (status === undefined) {
      if (!context.collectionComplete) unreadable.push(id);
    } else if (status !== "closed") {
      open.push(id);
    }
  }
  if (open.length > 0) return { rule: "blocked-open", ids: open };
  if (unreadable.length > 0) return { rule: "blocked-unreadable", ids: unreadable };
  const parentId = parentIdOf(issue.id);
  if (parentId === undefined) return undefined;
  const parentStatus = context.parentStatus ?? byId.get(parentId)?.status;
  return parentStatus === "in_progress" ? { rule: "blocked-parent-in-progress", parentId } : undefined;
}

export function isBlocked(issue: UnclassifiedIssue, context: ClassifyContext): boolean {
  return blockedReason(issue, context) !== undefined;
}

export function hasLiveStructuralBlocker(
  issue: UnclassifiedIssue,
  context: ClassifyContext,
): boolean {
  return isUmbrella(issue, context) || isBlocked(issue, context);
}

export function classify(issue: UnclassifiedIssue, context: ClassifyContext): Classified {
  if (issue.status === "closed") {
    return { classification: undefined, reason: { rule: "closed" } };
  }
  if (issue.status === "in_progress") {
    const lane = workingLane(issue, context.lanes);
    return lane === undefined
      ? { classification: "landing", reason: { rule: "in-progress-no-lane" } }
      : { classification: "in-flight", reason: { rule: "in-progress-lane", slot: lane.slot } };
  }
  if (issue.labels.includes("needs-decision")) {
    return { classification: "yours:decision", reason: { rule: "label", label: "needs-decision" } };
  }
  if (issue.labels.includes("needs-access")) {
    return { classification: "yours:access", reason: { rule: "label", label: "needs-access" } };
  }
  for (const [label, parked] of PARKED_LABELS) {
    if (issue.labels.includes(label)) {
      return { classification: parked, reason: { rule: "label", label } };
    }
  }
  const umbrella = umbrellaReason(issue, context);
  if (umbrella !== undefined) {
    return { classification: "parked:umbrella", reason: umbrella };
  }
  const blocked = blockedReason(issue, context);
  if (blocked !== undefined) {
    return { classification: "blocked", reason: blocked };
  }
  const stored = context.stored?.get(issue.id);
  if (stored !== undefined) {
    return {
      classification: stored.classification,
      reason: { rule: "stored-status", status: stored.status },
    };
  }
  return { classification: "ready", reason: { rule: "default" } };
}
