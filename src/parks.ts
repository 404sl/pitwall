import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CollectionError, Issue } from "@404sl/pitwall-schema";
import type { IssueText } from "./beads.js";
import type { ParkBasis, ParkEntry, ParkStore, ProjectParks } from "./board.js";
import { parkLabelOf } from "./classify.js";
import { collectionError } from "./errors.js";
import { lastNote, withoutStampLines } from "./staleness.js";
import { stateHome, type StateOptions } from "./state.js";

export interface ConsoleState {
  parks: ParkStore;
}

export interface StoredConsole {
  path: string;
  state: ConsoleState;
  error?: CollectionError;
}

const BASES: readonly ParkBasis[] = ["carried", "first-seen"];

export function consolePath(options: StateOptions = {}): string {
  return join(stateHome(options), "pitwall", "console.json");
}

function entryOf(value: unknown): ParkEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { label, parkedSince, basis, question } = value as Record<string, unknown>;
  if (typeof label !== "string" || typeof parkedSince !== "string" || Number.isNaN(Date.parse(parkedSince))) {
    return undefined;
  }
  if (!BASES.includes(basis as ParkBasis)) {
    return undefined;
  }
  return {
    label,
    parkedSince,
    basis: basis as ParkBasis,
    ...(typeof question === "string" ? { question } : {}),
  };
}

function projectParksOf(value: unknown): ProjectParks {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const parks: ProjectParks = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    const read = entryOf(entry);
    if (read !== undefined) {
      parks[id] = read;
    }
  }
  return parks;
}

function storeOf(value: unknown): ParkStore {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const parks = (value as { parks?: unknown }).parks;
  if (typeof parks !== "object" || parks === null) {
    return {};
  }
  const store: ParkStore = {};
  for (const [project, entries] of Object.entries(parks as Record<string, unknown>)) {
    store[project] = projectParksOf(entries);
  }
  return store;
}

function isAbsent(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "ENOENT";
}

export function readConsoleState(options: StateOptions = {}): StoredConsole {
  const path = consolePath(options);
  try {
    return { path, state: { parks: storeOf(JSON.parse(readFileSync(path, "utf8"))) } };
  } catch (cause) {
    return isAbsent(cause)
      ? { path, state: { parks: {} } }
      : { path, state: { parks: {} }, error: collectionError(path, cause) };
  }
}

export function writeConsoleState(state: ConsoleState, options: StateOptions = {}): string {
  const path = consolePath(options);
  const staging = `${path}.${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(staging, path);
  return path;
}

function questionIn(text: string): string | undefined {
  const asked = withoutStampLines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?"));
  return asked[asked.length - 1];
}

export function questionOf(issue: { title: string; description?: string; notes?: string }): string | undefined {
  const sources = [issue.title, issue.notes === undefined ? "" : lastNote(issue.notes), issue.description ?? ""];
  for (const source of sources) {
    const found = questionIn(source);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function parksFor(
  issues: readonly Issue[],
  texts: ReadonlyMap<string, IssueText>,
  previous: ProjectParks | undefined,
  at: string,
): ProjectParks {
  const parks: ProjectParks = {};
  for (const issue of issues) {
    const label = parkLabelOf(issue);
    if (label === undefined) {
      continue;
    }
    const before = previous?.[issue.id];
    const carried = before !== undefined && before.label === label;
    const text = texts.get(issue.id);
    const question =
      issue.classification === "yours:decision"
        ? questionOf({ title: issue.title, description: text?.description, notes: text?.notes })
        : undefined;
    parks[issue.id] = {
      label,
      parkedSince: carried ? before.parkedSince : at,
      basis: carried ? "carried" : "first-seen",
      ...(question === undefined ? {} : { question }),
    };
  }
  return parks;
}
