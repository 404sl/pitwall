import type { Classification, Issue, Lane } from "@404sl/pitwall-schema";

export type UnclassifiedIssue = Omit<Issue, "classification" | "staleness">;

export interface ClassifyContext {
  issues: readonly UnclassifiedIssue[];
  lanes: readonly Lane[];
  collectionComplete: boolean;
  stored?: ReadonlyMap<string, Classification>;
}

const PARKED_LABELS: ReadonlyArray<readonly [string, Classification]> = [
  ["blocked-tooling", "parked:tooling"],
  ["watch", "parked:watch"],
  ["umbrella", "parked:umbrella"],
  ["roadmap", "parked:roadmap"],
];

const EPIC_TITLE_MARKER = "[EPIC]";

function laneIsWorking(issue: UnclassifiedIssue, lanes: readonly Lane[]): boolean {
  return lanes.some((lane) => lane.state === "working" && lane.issueId === issue.id);
}

function isUmbrella(issue: UnclassifiedIssue, issues: readonly UnclassifiedIssue[]): boolean {
  if (issue.issueType === "epic") return true;
  if (issue.title.includes(EPIC_TITLE_MARKER)) return true;
  return issues.some(
    (other) =>
      other.id !== issue.id && other.id.startsWith(issue.id + ".") && other.status !== "closed",
  );
}

function parentIdOf(id: string): string | undefined {
  const cut = id.lastIndexOf(".");
  return cut === -1 ? undefined : id.slice(0, cut);
}

function isBlocked(issue: UnclassifiedIssue, context: ClassifyContext): boolean {
  const byId = new Map(context.issues.map((other) => [other.id, other]));
  const hasUnclosedEdge = issue.blockedBy.some((id) => {
    const blocker = byId.get(id);
    if (blocker === undefined) return !context.collectionComplete;
    return blocker.status !== "closed";
  });
  if (hasUnclosedEdge) return true;
  const parentId = parentIdOf(issue.id);
  return parentId !== undefined && byId.get(parentId)?.status === "in_progress";
}

export function classify(issue: UnclassifiedIssue, context: ClassifyContext): Classification {
  if (issue.status === "in_progress") {
    return laneIsWorking(issue, context.lanes) ? "in-flight" : "landing";
  }
  if (issue.labels.includes("needs-decision")) return "yours:decision";
  if (issue.labels.includes("needs-access")) return "yours:access";
  for (const [label, parked] of PARKED_LABELS) {
    if (issue.labels.includes(label)) return parked;
  }
  if (isUmbrella(issue, context.issues)) return "parked:umbrella";
  if (isBlocked(issue, context)) return "blocked";
  const stored = context.stored?.get(issue.id);
  if (stored !== undefined) return stored;
  return "ready";
}
