import type { CollectionError, Snapshot } from "@404sl/pitwall-schema";
import {
  PRECONDITIONS,
  PULL_SOURCE,
  STALENESS_SOURCE,
  UNRECORDED,
  unresolvedOf,
  type Unresolved,
} from "./staleness.js";

export type ProblemScope = "run" | "console" | "project";

export interface ProblemRow {
  scope: ProblemScope;
  name: string;
  source: string;
  message: string;
  at: string;
  prevented?: number;
}

export type Disposition = "act" | "derived" | "self-healing" | "limitation";

export const SELF_HEALING_GRACE_MS = 6 * 60 * 60_000;

const RUN_SCOPE = "";

const ISSUE_STALENESS = `${STALENESS_SOURCE} `;

const SELF_HEALING = [/rate limit/i, /^timed out after \d+ms$/];

const PROBE_SOURCES: readonly string[] = [
  PULL_SOURCE,
  ...PRECONDITIONS.map((precondition) => precondition.command.join(" ")),
];

export function problemKey(row: ProblemRow): string {
  return JSON.stringify([row.scope, row.name, row.source, row.at, row.message]);
}

function causeKey(name: string, source: string): string {
  return JSON.stringify([name, source]);
}

function isDerived(error: CollectionError): boolean {
  return error.source.startsWith(ISSUE_STALENESS) && unresolvedOf(error.message) !== undefined;
}

function isLimitation(error: CollectionError): boolean {
  return error.source === STALENESS_SOURCE && error.message.startsWith(UNRECORDED);
}

export function isSelfHealing(error: CollectionError): boolean {
  return (
    PROBE_SOURCES.includes(error.source) &&
    SELF_HEALING.some((pattern) => pattern.test(error.message))
  );
}

export function dispositionOf(error: CollectionError): Disposition {
  if (isDerived(error)) {
    return "derived";
  }
  if (isLimitation(error)) {
    return "limitation";
  }
  return isSelfHealing(error) ? "self-healing" : "act";
}

function causesOf(row: ProblemRow, named: Unresolved): readonly string[] {
  if (named.kind === "reference") {
    return [PULL_SOURCE];
  }
  return PRECONDITIONS.map((precondition) => precondition.command.join(" ")).filter((source) =>
    row.message.includes(source),
  );
}

function preventedCounts(rows: readonly ProblemRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const named = unresolvedOf(row.message);
    if (named === undefined || !isDerived(row)) {
      continue;
    }
    for (const source of causesOf(row, named)) {
      const key = causeKey(row.name, source);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function persistedFor(at: string, generatedAt: string): number | undefined {
  const started = Date.parse(at);
  const now = Date.parse(generatedAt);
  return Number.isNaN(started) || Number.isNaN(now) ? undefined : now - started;
}

function stillHealing(row: ProblemRow, generatedAt: string): boolean {
  const forMs = persistedFor(row.at, generatedAt);
  return forMs !== undefined && forMs < SELF_HEALING_GRACE_MS;
}

export function shownProblems(rows: readonly ProblemRow[], generatedAt: string): ProblemRow[] {
  const counts = preventedCounts(rows);
  const shown: ProblemRow[] = [];
  for (const row of rows) {
    const disposition = dispositionOf(row);
    if (disposition === "derived" || disposition === "limitation") {
      continue;
    }
    if (disposition === "self-healing" && stillHealing(row, generatedAt)) {
      continue;
    }
    const prevented = counts.get(causeKey(row.name, row.source));
    shown.push(prevented === undefined ? row : { ...row, prevented });
  }
  return shown;
}

function failingSince(snapshot: Snapshot): Map<string, string> {
  const since = new Map<string, string>();
  const record = (name: string, errors: readonly CollectionError[] | undefined): void => {
    for (const error of errors ?? []) {
      if (!isSelfHealing(error)) {
        continue;
      }
      const key = causeKey(name, error.source);
      const known = since.get(key);
      if (known === undefined || Date.parse(error.at) < Date.parse(known)) {
        since.set(key, error.at);
      }
    }
  };
  record(RUN_SCOPE, snapshot.errors);
  for (const project of snapshot.projects ?? []) {
    record(project.id, project.errors);
  }
  return since;
}

function kept(
  errors: readonly CollectionError[],
  name: string,
  since: ReadonlyMap<string, string>,
): CollectionError[] {
  return errors.map((error) => {
    if (!isSelfHealing(error)) {
      return error;
    }
    const started = since.get(causeKey(name, error.source));
    if (started === undefined || Date.parse(started) >= Date.parse(error.at)) {
      return error;
    }
    return { ...error, at: started };
  });
}

export function carryFailingSince(snapshot: Snapshot, previous: Snapshot | undefined): Snapshot {
  if (previous === undefined) {
    return snapshot;
  }
  const since = failingSince(previous);
  if (since.size === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    errors: kept(snapshot.errors ?? [], RUN_SCOPE, since),
    projects: (snapshot.projects ?? []).map((project) => ({
      ...project,
      errors: kept(project.errors ?? [], project.id, since),
    })),
  };
}
