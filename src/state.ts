import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSnapshot, type CollectionError, type Snapshot } from "@404sl/pitwall-schema";
import { collectionError } from "./autofix.js";

export const STATE_VAR = "XDG_STATE_HOME";

export interface StateOptions {
  env?: Record<string, string | undefined>;
  home?: string;
}

export type StoredSnapshot =
  | { path: string; snapshot: Snapshot; error?: undefined }
  | { path: string; snapshot?: undefined; error: CollectionError };

export function stateHome(options: StateOptions = {}): string {
  const override = (options.env ?? process.env)[STATE_VAR];
  if (override !== undefined && override !== "") {
    return resolve(override);
  }
  return join(options.home ?? homedir(), ".local", "state");
}

export function snapshotPath(options: StateOptions = {}): string {
  return join(stateHome(options), "pitwall", "snapshot.json");
}

export function readSnapshot(options: StateOptions = {}): StoredSnapshot {
  const path = snapshotPath(options);
  try {
    return { path, snapshot: parseSnapshot(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (cause) {
    return { path, error: collectionError(path, cause) };
  }
}
