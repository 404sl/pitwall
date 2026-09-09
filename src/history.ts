import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CollectionError, Metrics, Snapshot } from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";
import { stateHome, type StateOptions } from "./state.js";

export const DEFAULT_MAX_SNAPSHOTS = 500;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const DEFAULT_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const CREATE = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_generated_at ON snapshots (generated_at);
`;

const INSERT = "INSERT INTO snapshots (schema_version, generated_at, document) VALUES (?, ?, ?)";
const DELETE_OLDER = "DELETE FROM snapshots WHERE generated_at < ?";
const DELETE_BEYOND =
  "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)";
const SELECT_WINDOW =
  "SELECT generated_at, document FROM snapshots WHERE generated_at >= ? ORDER BY generated_at ASC, id ASC";

export interface HistoryLimits {
  maxSnapshots: number;
  maxAgeDays: number;
}

export interface HistoryOptions extends StateOptions {
  limits?: HistoryLimits;
  windowDays?: number;
  now?: Date;
}

export type HistoryMetrics = Pick<
  Metrics,
  "landedToday" | "closedToday" | "medianTimeToLandMinutes" | "bounceRate"
>;

export interface HistoryResult {
  path: string;
  metrics: Map<string, HistoryMetrics>;
  error?: CollectionError;
}

type Status = "open" | "in_progress" | "closed";

interface StoredProject {
  id: string;
  issues?: { id?: unknown; status?: unknown }[];
  errors?: unknown[];
}

interface StoredDocument {
  generatedAt?: unknown;
  projects?: StoredProject[];
}

interface StoredRow {
  generated_at: string;
  document: string;
}

interface Frame {
  at: Date;
  statuses: Map<string, Status>;
}

interface Track {
  claimedAt: Date | undefined;
  closedAt: Date | undefined;
  bounced: boolean;
}

export const DEFAULT_LIMITS: HistoryLimits = {
  maxSnapshots: DEFAULT_MAX_SNAPSHOTS,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
};

export function historyPath(options: StateOptions = {}): string {
  return join(stateHome(options), "pitwall", "history.db");
}

function statusOf(value: unknown): Status | undefined {
  return value === "open" || value === "in_progress" || value === "closed" ? value : undefined;
}

function frameOf(project: StoredProject, at: Date): Frame | undefined {
  const issues = project.issues ?? [];
  if (issues.length === 0 && (project.errors ?? []).length > 0) {
    return undefined;
  }
  const statuses = new Map<string, Status>();
  for (const issue of issues) {
    const status = statusOf(issue.status);
    if (typeof issue.id === "string" && status !== undefined) {
      statuses.set(issue.id, status);
    }
  }
  return { at, statuses };
}

function framesByProject(rows: Iterable<StoredRow>): Map<string, Frame[]> {
  const frames = new Map<string, Frame[]>();
  for (const row of rows) {
    const document = JSON.parse(row.document) as StoredDocument;
    const stamp = typeof document.generatedAt === "string" ? document.generatedAt : row.generated_at;
    const at = new Date(stamp);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    for (const project of document.projects ?? []) {
      const frame = frameOf(project, at);
      if (frame === undefined) {
        continue;
      }
      const seen = frames.get(project.id) ?? [];
      seen.push(frame);
      frames.set(project.id, seen);
    }
  }
  return frames;
}

function tracksOf(frames: readonly Frame[]): Map<string, Track> {
  const tracks = new Map<string, Track>();
  for (const frame of frames) {
    for (const [id, track] of tracks) {
      if (track.closedAt === undefined && !frame.statuses.has(id)) {
        track.closedAt = frame.at;
      }
    }
    for (const [id, status] of frame.statuses) {
      const track = tracks.get(id) ?? { claimedAt: undefined, closedAt: undefined, bounced: false };
      if (status === "in_progress" && track.claimedAt === undefined) {
        track.claimedAt = frame.at;
      }
      if (status === "open" && track.claimedAt !== undefined && track.closedAt === undefined) {
        track.bounced = true;
      }
      if (status === "closed" && track.closedAt === undefined) {
        track.closedAt = frame.at;
      }
      tracks.set(id, track);
    }
  }
  return tracks;
}

function sameDay(when: Date, day: Date): boolean {
  return (
    when.getFullYear() === day.getFullYear() &&
    when.getMonth() === day.getMonth() &&
    when.getDate() === day.getDate()
  );
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const at = sorted[middle] as number;
  if (sorted.length % 2 === 1) {
    return at;
  }
  return (at + (sorted[middle - 1] as number)) / 2;
}

function metricsOf(frames: readonly Frame[], day: Date): HistoryMetrics {
  const tracks = [...tracksOf(frames).values()];
  const landed = tracks.filter(
    (track) => track.closedAt !== undefined && track.claimedAt !== undefined,
  );
  const durations = landed.map(
    (track) => ((track.closedAt as Date).getTime() - (track.claimedAt as Date).getTime()) / MINUTE_MS,
  );
  const claimed = tracks.filter((track) => track.claimedAt !== undefined);
  const bounced = claimed.filter((track) => track.bounced);
  return {
    landedToday: landed.filter((track) => sameDay(track.closedAt as Date, day)).length,
    closedToday: tracks.filter(
      (track) => track.closedAt !== undefined && sameDay(track.closedAt, day),
    ).length,
    medianTimeToLandMinutes: median(durations.filter((minutes) => minutes >= 0)),
    bounceRate:
      frames.length < 2 || claimed.length === 0 ? undefined : bounced.length / claimed.length,
  };
}

function append(db: DatabaseSync, snapshot: Snapshot): void {
  db.prepare(INSERT).run(snapshot.schemaVersion, snapshot.generatedAt, JSON.stringify(snapshot));
}

function prune(db: DatabaseSync, limits: HistoryLimits, now: Date): void {
  db.prepare(DELETE_OLDER).run(new Date(now.getTime() - limits.maxAgeDays * DAY_MS).toISOString());
  db.prepare(DELETE_BEYOND).run(Math.max(Math.floor(limits.maxSnapshots), 1));
}

function derive(db: DatabaseSync, windowDays: number, now: Date): Map<string, HistoryMetrics> {
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const rows = db.prepare(SELECT_WINDOW).iterate(since) as unknown as Iterable<StoredRow>;
  const derived = new Map<string, HistoryMetrics>();
  for (const [id, frames] of framesByProject(rows)) {
    derived.set(id, metricsOf(frames, now));
  }
  return derived;
}

async function sqlite(): Promise<typeof import("node:sqlite") | undefined> {
  try {
    return await import("node:sqlite");
  } catch {
    return undefined;
  }
}

export async function recordSnapshot(
  snapshot: Snapshot,
  options: HistoryOptions = {},
): Promise<HistoryResult> {
  const path = historyPath(options);
  const now = options.now ?? new Date(snapshot.generatedAt);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const sql = await sqlite();
  if (sql === undefined) {
    return { path, metrics: new Map() };
  }
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new sql.DatabaseSync(path);
    db.exec(CREATE);
    append(db, snapshot);
    prune(db, limits, now);
    return { path, metrics: derive(db, options.windowDays ?? DEFAULT_WINDOW_DAYS, now) };
  } catch (cause) {
    return { path, metrics: new Map(), error: collectionError(path, cause) };
  } finally {
    db?.close();
  }
}
