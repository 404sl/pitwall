import type { CollectionError, Snapshot } from "@404sl/pitwall-schema";
import { fill } from "./format.js";
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

const UNACCOUNTED = "{count} staleness {checks} could not complete and nothing recorded why";

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

interface Accounting {
  prevented: Map<string, number>;
  unaccounted: Map<string, ProblemRow[]>;
}

function accountingOf(rows: readonly ProblemRow[]): Accounting {
  const recorded = new Set(rows.map((row) => causeKey(row.name, row.source)));
  const prevented = new Map<string, number>();
  const unaccounted = new Map<string, ProblemRow[]>();
  for (const row of rows) {
    const named = unresolvedOf(row.message);
    if (named === undefined || !isDerived(row)) {
      continue;
    }
    const known = causesOf(row, named)
      .map((source) => causeKey(row.name, source))
      .filter((key) => recorded.has(key));
    if (known.length === 0) {
      unaccounted.set(row.name, [...(unaccounted.get(row.name) ?? []), row]);
      continue;
    }
    for (const key of known) {
      prevented.set(key, (prevented.get(key) ?? 0) + 1);
    }
  }
  return { prevented, unaccounted };
}

function earliest(rows: readonly ProblemRow[]): string {
  return rows.reduce(
    (known, row) => (Date.parse(row.at) < Date.parse(known) ? row.at : known),
    rows[0]?.at ?? "",
  );
}

function unaccountedRow(rows: readonly ProblemRow[]): ProblemRow {
  const count = rows.length;
  return {
    scope: rows[0]?.scope ?? "project",
    name: rows[0]?.name ?? "",
    source: STALENESS_SOURCE,
    message: fill(UNACCOUNTED, { count: String(count), checks: count === 1 ? "check" : "checks" }),
    at: earliest(rows),
  };
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
  const { prevented, unaccounted } = accountingOf(rows);
  const shown: ProblemRow[] = [];
  for (const row of rows) {
    const disposition = dispositionOf(row);
    if (disposition === "derived" || disposition === "limitation") {
      continue;
    }
    if (disposition === "self-healing" && stillHealing(row, generatedAt)) {
      continue;
    }
    const count = prevented.get(causeKey(row.name, row.source));
    shown.push(count === undefined ? row : { ...row, prevented: count });
  }
  for (const group of unaccounted.values()) {
    shown.push(unaccountedRow(group));
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
