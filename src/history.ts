import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CollectionError, Metrics, Snapshot } from "@404sl/pitwall-schema";
import { collectionError } from "./errors.js";
import { stateHome, type StateOptions } from "./state.js";

export const DEFAULT_MAX_SNAPSHOTS = 500;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MIN_INTERVAL_MINUTES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const STORE_VERSION = 2;

const CREATE = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  document TEXT NOT NULL,
  frame TEXT
);
CREATE INDEX IF NOT EXISTS snapshots_generated_at ON snapshots (generated_at);
`;

const SELECT_FRAME_COLUMN =
  "SELECT count(*) AS held FROM pragma_table_info('snapshots') WHERE name = 'frame'";
const ADD_FRAME_COLUMN = "ALTER TABLE snapshots ADD COLUMN frame TEXT";
const SELECT_STORE_VERSION = "PRAGMA user_version";
const INSERT =
  "INSERT INTO snapshots (schema_version, generated_at, document, frame) VALUES (?, ?, ?, ?)";
const DELETE_OLDER = "DELETE FROM snapshots WHERE generated_at < ?";
const DELETE_BEYOND =
  "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)";
const SELECT_RECORDED = "SELECT max(generated_at) AS recorded FROM snapshots";
const SELECT_WINDOW =
  "SELECT generated_at, frame, CASE WHEN frame IS NULL THEN document END AS document FROM snapshots WHERE generated_at >= ? ORDER BY generated_at ASC, id ASC";

export interface HistoryLimits {
  maxSnapshots: number;
  maxAgeDays: number;
  minIntervalMinutes: number;
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
  frame: string | null;
  document: string | null;
}

interface HeldProject {
  id?: unknown;
  statuses?: Record<string, unknown>;
}

interface HeldFrame {
  projects?: HeldProject[];
}

interface Frame {
  at: Date;
  statuses: Map<string, Status>;
}

interface Reading {
  at: Date;
  projects: { id: string; statuses: Map<string, Status> }[];
}

interface Track {
  claimedAt: Date | undefined;
  closedAt: Date | undefined;
  bounced: boolean;
}

export const DEFAULT_LIMITS: HistoryLimits = {
  maxSnapshots: DEFAULT_MAX_SNAPSHOTS,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  minIntervalMinutes: DEFAULT_MIN_INTERVAL_MINUTES,
};

export function historyPath(options: StateOptions = {}): string {
  return join(stateHome(options), "pitwall", "history.db");
}

function statusOf(value: unknown): Status | undefined {
  return value === "open" || value === "in_progress" || value === "closed" ? value : undefined;
}

function statusesOf(project: StoredProject): Map<string, Status> | undefined {
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
  return statuses;
}

function frameText(snapshot: Snapshot): string {
  const projects: { id: string; statuses: Record<string, Status> }[] = [];
  for (const project of snapshot.projects) {
    const statuses = statusesOf(project);
    if (statuses === undefined) {
      continue;
    }
    projects.push({ id: project.id, statuses: Object.fromEntries(statuses) });
  }
  return JSON.stringify({ projects });
}

function readingOfFrame(text: string, at: Date): Reading {
  const held = JSON.parse(text) as HeldFrame;
  const projects: Reading["projects"] = [];
  for (const project of held.projects ?? []) {
    if (typeof project.id !== "string") {
      continue;
    }
    const statuses = new Map<string, Status>();
    for (const [id, value] of Object.entries(project.statuses ?? {})) {
      const status = statusOf(value);
      if (status !== undefined) {
        statuses.set(id, status);
      }
    }
    projects.push({ id: project.id, statuses });
  }
  return { at, projects };
}

function readingOfDocument(text: string, generatedAt: string): Reading | undefined {
  const document = JSON.parse(text) as StoredDocument;
  const stamp = typeof document.generatedAt === "string" ? document.generatedAt : generatedAt;
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) {
    return undefined;
  }
  const projects: Reading["projects"] = [];
  for (const project of document.projects ?? []) {
    const statuses = statusesOf(project);
    if (statuses === undefined) {
      continue;
    }
    projects.push({ id: project.id, statuses });
  }
  return { at, projects };
}

function readingOf(row: StoredRow): Reading | undefined {
  if (typeof row.frame === "string") {
    const at = new Date(row.generated_at);
    return Number.isNaN(at.getTime()) ? undefined : readingOfFrame(row.frame, at);
  }
  return typeof row.document === "string"
    ? readingOfDocument(row.document, row.generated_at)
    : undefined;
}

function framesByProject(rows: Iterable<StoredRow>): Map<string, Frame[]> {
  const frames = new Map<string, Frame[]>();
  for (const row of rows) {
    const reading = readingOf(row);
    if (reading === undefined) {
      continue;
    }
    for (const project of reading.projects) {
      const seen = frames.get(project.id) ?? [];
      seen.push({ at: reading.at, statuses: project.statuses });
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

function migrate(db: DatabaseSync): void {
  const held = db.prepare(SELECT_FRAME_COLUMN).get() as { held: number };
  if (held.held === 0) {
    db.exec(ADD_FRAME_COLUMN);
  }
  const version = db.prepare(SELECT_STORE_VERSION).get() as { user_version: number };
  if (version.user_version !== STORE_VERSION) {
    db.exec(`PRAGMA user_version = ${STORE_VERSION}`);
  }
}

function append(db: DatabaseSync, snapshot: Snapshot): void {
  db.prepare(INSERT).run(
    snapshot.schemaVersion,
    snapshot.generatedAt,
    JSON.stringify(snapshot),
    frameText(snapshot),
  );
}

function recordedAt(db: DatabaseSync): Date | undefined {
  const held = db.prepare(SELECT_RECORDED).get() as { recorded: string | null };
  if (typeof held.recorded !== "string") {
    return undefined;
  }
  const at = new Date(held.recorded);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function tooSoon(db: DatabaseSync, limits: HistoryLimits, now: Date): boolean {
  const recorded = recordedAt(db);
  if (recorded === undefined) {
    return false;
  }
  return now.getTime() - recorded.getTime() < limits.minIntervalMinutes * MINUTE_MS;
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
    migrate(db);
    if (!tooSoon(db, limits, now)) {
      append(db, snapshot);
      prune(db, limits, now);
    }
    return { path, metrics: derive(db, options.windowDays ?? DEFAULT_WINDOW_DAYS, now) };
  } catch (cause) {
    return { path, metrics: new Map(), error: collectionError(path, cause) };
  } finally {
    db?.close();
  }
}
