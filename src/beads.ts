import { execFile } from "node:child_process";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  Issue,
  resolveOrigin,
  type Classification,
  type CollectionError,
  type Lane,
  type Origin,
} from "@404sl/pitwall-schema";
import { workspaceFile } from "./autofix.js";
import { collectionError, failureOf } from "./errors.js";
import { LOCK_ROOT } from "./lanes.js";
import { NOTE_STAMP } from "./staleness.js";
import {
  classify,
  parentIdOf,
  type ClassificationReason,
  type ClassifyContext,
  type StoredClassification,
  type UnclassifiedIssue,
} from "./classify.js";

const run = promisify(execFile);

export const BEADS_DIR = ".beads";
export const BEADS_DIR_VAR = "BEADS_DIR";

const MAX_OUTPUT = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

type Status = UnclassifiedIssue["status"];

const STATUSES_ARGS = ["statuses", "--json"];
const LIST_ARGS = ["list", "--all", "--limit", "0", "--json"];
const BLOCKED_ARGS = ["blocked", "--json"];

const LIST_COMMAND = ["bd", ...LIST_ARGS].join(" ");

const BLOCKS = "blocks";
const PARENT_CHILD = "parent-child";

export function showArgs(id: string): string[] {
  return ["show", "--id", id, "--json", "--include-dependents"];
}

const STORED_STATUS = new Map<string, Status>([
  ["open", "open"],
  ["in_progress", "in_progress"],
  ["blocked", "open"],
  ["deferred", "open"],
  ["closed", "closed"],
  ["pinned", "open"],
  ["hooked", "in_progress"],
]);

const STORED_CLASSIFICATION = new Map<string, Classification>([
  ["blocked", "blocked"],
  ["deferred", "parked:roadmap"],
  ["pinned", "parked:watch"],
]);

const CATEGORY_STATUS = new Map<string, Status>([
  ["active", "open"],
  ["wip", "in_progress"],
  ["frozen", "open"],
  ["done", "closed"],
]);

const CATEGORY_CLASSIFICATION = new Map<string, Classification>([["frozen", "parked:roadmap"]]);

export interface ReadIssuesOptions {
  env?: Record<string, string | undefined>;
  lanes?: readonly Lane[];
  errors: readonly CollectionError[];
  timeoutMs?: number;
}

export interface ReadIssueOptions {
  env?: Record<string, string | undefined>;
  lanes?: readonly Lane[];
  issues: readonly UnclassifiedIssue[];
  collectionComplete: boolean;
  timeoutMs?: number;
}

export interface ClosedIssue extends UnclassifiedIssue {
  closedAt: string | undefined;
  closeReason: string | undefined;
  externalRef: string | undefined;
}

export interface IssueText {
  description: string | undefined;
  notes: string | undefined;
}

export interface CollectedIssues {
  issues: Issue[];
  closed: ClosedIssue[];
  linked: string[];
  texts: Map<string, IssueText>;
  errors: CollectionError[];
}

export interface DependencyLink {
  id: string;
  title: string;
  status: string;
}

export interface IssueDetail {
  id: string;
  title: string;
  status: Status;
  issueType: string | undefined;
  priority: number | undefined;
  labels: string[];
  createdAt: string | undefined;
  updatedAt: string | undefined;
  owner: string | undefined;
  reporter: string | undefined;
  description: string | undefined;
  notes: string | undefined;
  origin: Origin | undefined;
  classification: Classification | undefined;
  reason: ClassificationReason;
  blockedBy: DependencyLink[];
  blocks: DependencyLink[];
}

export type IssueReading =
  | { kind: "found"; issue: IssueDetail; tried: string[] }
  | { kind: "missing"; tried: string[] }
  | { kind: "unreadable"; error: CollectionError; tried: string[] };

interface Reader {
  beadsDir: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  tried: string[];
}

function readerFor(root: string, options: Pick<ReadIssuesOptions, "env" | "timeoutMs">): Reader {
  return {
    beadsDir: join(resolve(root), BEADS_DIR),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    tried: [],
  };
}

async function bd<T>(
  reader: Reader,
  args: readonly string[],
  shape: (parsed: unknown) => T,
): Promise<T> {
  const command = ["bd", ...args].join(" ");
  reader.tried.push(command);
  let stdout: string;
  try {
    ({ stdout } = await run("bd", args as string[], {
      encoding: "utf8",
      env: { ...reader.env, [BEADS_DIR_VAR]: reader.beadsDir },
      maxBuffer: MAX_OUTPUT,
      timeout: reader.timeoutMs,
    }));
  } catch (cause) {
    throw new Error(`${command}: ${failureOf(cause, reader.timeoutMs)}`, { cause });
  }
  try {
    return shape(JSON.parse(stdout));
  } catch (cause) {
    throw new Error(`${command}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function asRows(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) {
    throw new TypeError("output is not an array of issues");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`issue ${index} is not an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function asRecord(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("output is not an object");
  }
  return parsed as Record<string, unknown>;
}

function categoriesOf(reported: Record<string, unknown>): Map<string, string> {
  const categories = new Map<string, string>();
  for (const key of ["built_in_statuses", "custom_statuses"]) {
    const listed = reported[key];
    if (!Array.isArray(listed)) continue;
    for (const entry of listed) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, category } = entry as Record<string, unknown>;
      if (typeof name === "string" && typeof category === "string") {
        categories.set(name, category);
      }
    }
  }
  return categories;
}

interface Mapping {
  status: Status;
  parked: Classification | undefined;
}

function mappingOf(
  stored: string,
  id: string,
  categories: ReadonlyMap<string, string>,
  command: string = LIST_COMMAND,
): Mapping {
  const known = STORED_STATUS.get(stored);
  if (known !== undefined) {
    return { status: known, parked: STORED_CLASSIFICATION.get(stored) };
  }
  const category = categories.get(stored);
  if (category === undefined) {
    throw new Error(`${command}: ${id} has the unknown stored status ${stored}`);
  }
  const byCategory = CATEGORY_STATUS.get(category);
  if (byCategory === undefined) {
    throw new Error(
      `${command}: ${id} has the stored status ${stored} in the unknown category ${category}`,
    );
  }
  return { status: byCategory, parked: CATEGORY_CLASSIFICATION.get(category) };
}

function statusWordOf(stored: unknown, categories: ReadonlyMap<string, string>): string {
  if (typeof stored !== "string" || stored === "") {
    return "";
  }
  const known = STORED_STATUS.get(stored);
  if (known !== undefined) {
    return known;
  }
  const category = categories.get(stored);
  const byCategory = category === undefined ? undefined : CATEGORY_STATUS.get(category);
  return byCategory ?? stored;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function labelsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((label): label is string => typeof label === "string") : [];
}

function originOf(value: unknown): Origin | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const origin = (value as Record<string, unknown>)["origin"];
  if (typeof origin !== "object" || origin === null) return undefined;
  const { session, ref } = origin as Record<string, unknown>;
  if (typeof session !== "string" || typeof ref !== "string") return undefined;
  return { session, ref };
}

function blockedEdges(rows: readonly Record<string, unknown>[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const row of rows) {
    const id = row["id"];
    if (typeof id !== "string") continue;
    edges.set(id, labelsOf(row["blocked_by"]));
  }
  return edges;
}

function toIssue(
  row: Record<string, unknown>,
  categories: ReadonlyMap<string, string>,
  edges: ReadonlyMap<string, string[]>,
  parked: Map<string, StoredClassification>,
  texts: Map<string, IssueText>,
): ClosedIssue {
  const id = row["id"];
  if (typeof id !== "string") {
    throw new TypeError("an issue has no id");
  }
  const stored = row["status"];
  if (typeof stored !== "string") {
    throw new Error(`${LIST_COMMAND}: ${id} has no stored status`);
  }
  const mapping = mappingOf(stored, id, categories);
  if (mapping.parked !== undefined) {
    parked.set(id, { classification: mapping.parked, status: stored });
  }
  texts.set(id, { description: textOf(row["description"]), notes: textOf(row["notes"]) });
  return {
    id,
    title: typeof row["title"] === "string" ? row["title"] : id,
    status: mapping.status,
    issueType: textOf(row["issue_type"]),
    priority: typeof row["priority"] === "number" ? row["priority"] : undefined,
    labels: labelsOf(row["labels"]),
    createdAt: textOf(row["created_at"]),
    updatedAt: textOf(row["updated_at"]),
    owner: textOf(row["assignee"]),
    reporter: textOf(row["created_by"]),
    blockedBy: edges.get(id) ?? [],
    origin: originOf(row["metadata"]),
    closedAt: textOf(row["closed_at"]),
    closeReason: textOf(row["close_reason"]),
    externalRef: textOf(row["external_ref"]),
  };
}

interface Collection {
  all: ClosedIssue[];
  parked: Map<string, StoredClassification>;
  texts: Map<string, IssueText>;
  categories: ReadonlyMap<string, string>;
}

async function collect(reader: Reader): Promise<Collection> {
  const categories = categoriesOf(await bd(reader, STATUSES_ARGS, asRecord));
  const rows = await bd(reader, LIST_ARGS, asRows);
  const edges = blockedEdges(await bd(reader, BLOCKED_ARGS, asRows));
  const parked = new Map<string, StoredClassification>();
  const texts = new Map<string, IssueText>();
  return {
    all: rows.map((row) => toIssue(row, categories, edges, parked, texts)),
    parked,
    texts,
    categories,
  };
}

function contextFor(
  root: string,
  collection: Collection,
  options: ReadIssuesOptions,
): ClassifyContext {
  return {
    issues: collection.all,
    lanes: options.lanes ?? [],
    collectionComplete: !collectionFailed(root, options.errors),
    stored: collection.parked,
  };
}

export async function readIssues(
  root: string,
  options: ReadIssuesOptions,
): Promise<CollectedIssues> {
  const reader = readerFor(root, options);
  try {
    const collection = await collect(reader);
    const active = collection.all.filter((issue) => issue.status !== "closed");
    const closed = collection.all.filter((issue) => issue.status === "closed");
    const byId = new Map(collection.all.map((issue) => [issue.id, issue]));
    const context = contextFor(root, collection, options);
    const issues = active.map((issue) =>
      Issue.parse({
        ...issue,
        origin: resolveOrigin(issue, byId),
        classification: classify(issue, context).classification,
      }),
    );
    const linked = collection.all
      .map((issue) => issue.externalRef)
      .filter((reference): reference is string => reference !== undefined);
    return { issues, closed, linked, texts: collection.texts, errors: [] };
  } catch (cause) {
    return {
      issues: [],
      closed: [],
      linked: [],
      texts: new Map(),
      errors: [collectionError(reader.beadsDir, cause)],
    };
  }
}

export function appendNotesArgs(id: string, text: string): string[] {
  return ["update", id, "--append-notes", text];
}

export const SESSION_VAR = "PITWALL_SESSION";
export const DEFAULT_LOCK_PREFIX = "devloop";
export const NOTE_LOCK = "bd-write.lock";
export const NOTE_ATTEMPTS = 3;

export interface NotePace {
  lockWaitMs: number;
  lockPollMs: number;
  settleMs: number;
  retryMs: number;
}

export const DEFAULT_NOTE_PACE: NotePace = {
  lockWaitMs: 60_000,
  lockPollMs: 500,
  settleMs: 300,
  retryMs: 1000,
};

export interface NoteOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  lockRoot?: string;
  pace?: Partial<NotePace>;
  warn?: (line: string) => void;
}

export function writerOf(env: Record<string, string | undefined>): string {
  const named = env[SESSION_VAR] || env["USER"] || "unknown";
  const word = named.replace(/\s+/g, "-").replace(/^-/, "").replace(/-$/, "");
  return word === "" ? "unknown" : word;
}

export function noteStamp(writer: string, now: Date): string {
  const stamp = `${now.toISOString().replace(/\.\d{3}Z$/, "Z")} ${writer}`;
  if (!NOTE_STAMP.test(stamp)) {
    throw new Error(`the stamp ${JSON.stringify(stamp)} is not one a reader recognises`);
  }
  return stamp;
}

function stampedWith(stamp: string, text: string): string {
  return `\n${stamp}\n${text}`;
}

export function stampNote(text: string, writer: string, now: Date): string {
  return stampedWith(noteStamp(writer, now), text);
}

function alnum(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, "");
}

export function storedNotes(shown: unknown): string {
  const row = Array.isArray(shown) ? shown[0] : shown;
  if (typeof row !== "object" || row === null) {
    return "";
  }
  const notes = (row as Record<string, unknown>)["notes"];
  return typeof notes === "string" ? alnum(notes) : "";
}

export type NoteVerdict =
  | { verdict: "landed" }
  | { verdict: "absent" }
  | { verdict: "diverged"; at: number };

export function noteVerdict(
  shown: unknown,
  text: string,
  stamp: string,
  before?: string,
): NoteVerdict {
  const kept: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (alnum(text.slice(index, index + 1)) !== "") {
      kept.push(index);
    }
  }
  const whole = kept.map((index) => text.slice(index, index + 1)).join("");
  if (whole === "") {
    return { verdict: "absent" };
  }
  const stored = storedNotes(shown);
  const region =
    before !== undefined && stored.startsWith(before) ? stored.slice(before.length) : stored;
  if (region.includes(whole)) {
    return { verdict: "landed" };
  }
  const mark = alnum(stamp);
  const marked = mark === "" ? -1 : region.lastIndexOf(mark);
  if (marked < 0) {
    return { verdict: "absent" };
  }
  const mine = region.slice(marked + mark.length);
  let low = 0;
  let high = whole.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (mine.includes(whole.slice(0, mid))) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { verdict: "diverged", at: kept[low] ?? text.length };
}

export function noteLockPath(lockPrefix: string, lockRoot: string = LOCK_ROOT): string {
  return join(lockRoot, `${lockPrefix}-${NOTE_LOCK}`);
}

async function lockPrefixAt(root: string): Promise<string> {
  const found = workspaceFile(root);
  if (found === undefined) {
    return DEFAULT_LOCK_PREFIX;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(found.path, "utf8"));
    const prefix = (parsed as Record<string, unknown> | null)?.["lockPrefix"];
    return typeof prefix === "string" && prefix !== "" ? prefix : DEFAULT_LOCK_PREFIX;
  } catch {
    return DEFAULT_LOCK_PREFIX;
  }
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((done) => setTimeout(done, ms));
}

async function takeLock(path: string, pace: NotePace): Promise<boolean> {
  const deadline = Date.now() + pace.lockWaitMs;
  for (;;) {
    try {
      await mkdir(path);
      return true;
    } catch (cause) {
      if ((cause as { code?: unknown } | null)?.code !== "EEXIST") {
        return false;
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(pace.lockPollMs);
  }
}

interface NoteWriter {
  beadsDir: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  lockRoot: string | undefined;
  pace: NotePace;
  warn: (line: string) => void;
}

function noteWriterFor(root: string, options: NoteOptions): NoteWriter {
  return {
    beadsDir: join(resolve(root), BEADS_DIR),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    lockRoot: options.lockRoot,
    pace: { ...DEFAULT_NOTE_PACE, ...options.pace },
    warn: options.warn ?? ((line) => void process.stderr.write(`pitwall: ${line}\n`)),
  };
}

async function bdWrite(writer: NoteWriter, args: readonly string[]): Promise<string> {
  const { stdout } = await run("bd", args as string[], {
    encoding: "utf8",
    env: { ...writer.env, [BEADS_DIR_VAR]: writer.beadsDir },
    maxBuffer: MAX_OUTPUT,
    timeout: writer.timeoutMs,
  });
  return stdout;
}

type ReadBack = NoteVerdict | { verdict: "unreadable" };

async function notesShown(writer: NoteWriter, id: string): Promise<unknown> {
  return JSON.parse(await bdWrite(writer, showArgs(id)));
}

async function notesBefore(writer: NoteWriter, id: string): Promise<string | undefined> {
  try {
    return storedNotes(await notesShown(writer, id));
  } catch {
    return undefined;
  }
}

async function readBack(
  writer: NoteWriter,
  id: string,
  text: string,
  stamp: string,
  before: string | undefined,
): Promise<ReadBack> {
  try {
    return noteVerdict(await notesShown(writer, id), text, stamp, before);
  } catch {
    return { verdict: "unreadable" };
  }
}

async function appendVerified(writer: NoteWriter, id: string, text: string): Promise<void> {
  const described = `bd update ${id} --append-notes`;
  const stamp = noteStamp(writerOf(writer.env), new Date());
  const stamped = stampedWith(stamp, text);
  const args = appendNotesArgs(id, stamped);
  for (let attempt = 1; attempt <= NOTE_ATTEMPTS; attempt++) {
    const before = await notesBefore(writer, id);
    let refused: string | undefined;
    try {
      await bdWrite(writer, args);
    } catch (cause) {
      refused = failureOf(cause, writer.timeoutMs);
    }
    let read = await readBack(writer, id, text, stamp, before);
    if (read.verdict !== "landed" && read.verdict !== "unreadable" && refused === undefined) {
      await sleep(writer.pace.settleMs);
      read = await readBack(writer, id, text, stamp, before);
    }
    if (read.verdict === "landed") {
      if (attempt > 1) {
        writer.warn(`note on ${id} landed on attempt ${attempt}`);
      }
      return;
    }
    if (refused !== undefined) {
      throw new Error(`${described}: ${refused}`);
    }
    if (read.verdict === "diverged") {
      writer.warn(
        `note on ${id} differs from what was sent - diverges at character ${read.at + 1} of ${text.length}, not retrying`,
      );
      writer.warn(`first divergent characters: ${JSON.stringify(text.slice(read.at, read.at + 60))}`);
      writer.warn("the note as sent follows, so it is not lost whatever landed:");
      writer.warn(stamped);
      return;
    }
    if (read.verdict === "unreadable") {
      writer.warn(`could not read ${id} back to verify the note - it may well have landed, not retrying`);
      return;
    }
    if (attempt < NOTE_ATTEMPTS) {
      await sleep(writer.pace.retryMs);
    }
  }
  writer.warn(`note on ${id} did NOT land after ${NOTE_ATTEMPTS} attempts - the text follows so it is not lost:`);
  writer.warn(stamped);
  throw new Error(`${described}: the note did not land after ${NOTE_ATTEMPTS} attempts`);
}

async function appendNote(writer: NoteWriter, root: string, id: string, text: string): Promise<void> {
  const lock = noteLockPath(await lockPrefixAt(root), writer.lockRoot);
  const held = await takeLock(lock, writer.pace);
  if (!held) {
    writer.warn(`${lock} busy after ${writer.pace.lockWaitMs}ms, writing ${id} unserialised (read-back still applies)`);
  }
  try {
    await appendVerified(writer, id, text);
  } finally {
    if (held) {
      await rmdir(lock).catch(() => undefined);
    }
  }
}

export function noteAppender(
  root: string,
  options: NoteOptions = {},
): (id: string, text: string) => Promise<void> {
  const writer = noteWriterFor(root, options);
  return (id, text) => appendNote(writer, root, id, text);
}

export const OWNER_LABELS = ["needs-decision", "needs-access"] as const;

export interface IssueAction {
  note?: string;
  removeLabels?: readonly string[];
  metadataFile?: string;
}

export type IssueActor = (id: string, action: IssueAction) => Promise<void>;

export interface NewIssue {
  title: string;
  bodyFile: string;
  metadataFile: string;
  assignee: string;
  labels: readonly string[];
  issueType: string;
  externalRef?: string;
  actor?: string;
}

export type IssueCreator = (issue: NewIssue) => Promise<string>;

export class IssueActionFailure extends Error {
  readonly noted: boolean;

  constructor(message: string, noted: boolean) {
    super(message);
    this.name = "IssueActionFailure";
    this.noted = noted;
  }
}

export function removeLabelArgs(id: string, labels: readonly string[]): string[] {
  return ["update", id, ...labels.flatMap((label) => ["--remove-label", label])];
}

export function setMetadataArgs(id: string, file: string): string[] {
  return ["update", id, "--metadata", `@${file}`];
}

export function createArgs(issue: NewIssue): string[] {
  return [
    ...(issue.actor === undefined ? [] : ["--actor", issue.actor]),
    "create",
    `--title=${issue.title}`,
    "--type",
    issue.issueType,
    "--assignee",
    issue.assignee,
    ...issue.labels.flatMap((label) => ["--labels", label]),
    ...(issue.externalRef === undefined ? [] : ["--external-ref", issue.externalRef]),
    "--body-file",
    issue.bodyFile,
    "--metadata",
    `@${issue.metadataFile}`,
    "--silent",
  ];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const CREATED = /^(?:.*\bCreated issue:\s*)?([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function createdId(stdout: string): string | undefined {
  const lines = stdout.replace(ANSI, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line !== "") {
      return CREATED.exec(line)?.[1];
    }
  }
  return undefined;
}

function bdCaller(
  root: string,
  options: Omit<ReadIssuesOptions, "errors">,
): (args: readonly string[], described: string) => Promise<string> {
  const beadsDir = join(resolve(root), BEADS_DIR);
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return async (args, described) => {
    try {
      const { stdout } = await run("bd", args as string[], {
        encoding: "utf8",
        env: { ...env, [BEADS_DIR_VAR]: beadsDir },
        maxBuffer: MAX_OUTPUT,
        timeout: timeoutMs,
      });
      return stdout;
    } catch (cause) {
      throw new Error(`${described}: ${failureOf(cause, timeoutMs)}`);
    }
  };
}

export function issueCreator(
  root: string,
  options: Omit<ReadIssuesOptions, "errors"> = {},
): IssueCreator {
  const call = bdCaller(root, options);
  return async (issue) => {
    const stdout = await call(createArgs(issue), "bd create");
    const id = createdId(stdout);
    if (id === undefined) {
      throw new Error(`bd create: it reported no issue id, only ${JSON.stringify(stdout)}`);
    }
    return id;
  };
}

export function issueActor(root: string, options: NoteOptions = {}): IssueActor {
  const writer = noteWriterFor(root, options);
  return async (id, action) => {
    const { note, metadataFile } = action;
    const labels = action.removeLabels ?? [];
    let noted = false;
    try {
      if (metadataFile !== undefined) {
        try {
          await bdWrite(writer, setMetadataArgs(id, metadataFile));
        } catch (cause) {
          throw new Error(`bd update ${id} --metadata: ${failureOf(cause, writer.timeoutMs)}`);
        }
      }
      if (note !== undefined && note !== "") {
        await appendNote(writer, root, id, note);
        noted = true;
      }
      if (labels.length > 0) {
        try {
          await bdWrite(writer, removeLabelArgs(id, labels));
        } catch (cause) {
          throw new Error(`bd update ${id} --remove-label: ${failureOf(cause, writer.timeoutMs)}`);
        }
      }
    } catch (cause) {
      throw new IssueActionFailure(cause instanceof Error ? cause.message : String(cause), noted);
    }
  };
}

function linksOf(value: unknown, categories: ReadonlyMap<string, string>): DependencyLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const id = row["id"];
    if (typeof id !== "string" || row["dependency_type"] !== BLOCKS) return [];
    return [
      {
        id,
        title: typeof row["title"] === "string" ? row["title"] : id,
        status: statusWordOf(row["status"], categories),
      },
    ];
  });
}

export function collectionFailed(root: string, errors: readonly CollectionError[]): boolean {
  const beadsDir = join(resolve(root), BEADS_DIR);
  return errors.some((error) => error.source === beadsDir);
}

const NO_ISSUE_REPORTED = /no issues? found/i;

function reportsNoIssue(cause: unknown): boolean {
  const reported = (cause as { cause?: { stdout?: unknown } } | null)?.cause?.stdout;
  if (typeof reported !== "string") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(reported);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const error = (parsed as Record<string, unknown>)["error"];
    return typeof error === "string" && NO_ISSUE_REPORTED.test(error);
  } catch {
    return false;
  }
}

function statusesIn(row: Record<string, unknown>): unknown[] {
  const linked = [row["dependencies"], row["dependents"]].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  return [
    row["status"],
    ...linked.map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)["status"]
        : undefined,
    ),
  ];
}

function allMapped(statuses: readonly unknown[]): boolean {
  return statuses.every(
    (status) => typeof status !== "string" || status === "" || STORED_STATUS.has(status),
  );
}

function parentChildStatuses(
  value: unknown,
  categories: ReadonlyMap<string, string>,
  wanted: (id: string) => boolean,
): Map<string, string> {
  const reported = new Map<string, string>();
  if (!Array.isArray(value)) {
    return reported;
  }
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row["id"];
    if (typeof id !== "string" || row["dependency_type"] !== PARENT_CHILD || !wanted(id)) continue;
    const status = statusWordOf(row["status"], categories);
    if (status !== "") reported.set(id, status);
  }
  return reported;
}

function statusOfEach(links: readonly DependencyLink[]): Map<string, string> {
  const reported = new Map<string, string>();
  for (const link of links) {
    if (link.status !== "") {
      reported.set(link.id, link.status);
    }
  }
  return reported;
}

export async function readIssue(
  root: string,
  id: string,
  options: ReadIssueOptions,
): Promise<IssueReading> {
  const reader = readerFor(root, options);
  try {
    const args = showArgs(id);
    const command = ["bd", ...args].join(" ");
    let shown: Record<string, unknown>[];
    try {
      shown = await bd(reader, args, asRows);
    } catch (cause) {
      if (reportsNoIssue(cause)) {
        return { kind: "missing", tried: reader.tried };
      }
      throw cause;
    }
    const row = shown[0];
    if (row === undefined) {
      return { kind: "missing", tried: reader.tried };
    }
    const categories = allMapped(statusesIn(row))
      ? new Map<string, string>()
      : categoriesOf(await bd(reader, STATUSES_ARGS, asRecord));
    const stored = row["status"];
    if (typeof stored !== "string") {
      throw new Error(`${command}: ${id} has no stored status`);
    }
    const mapping = mappingOf(stored, id, categories, command);
    const blockedBy = linksOf(row["dependencies"], categories);
    const listed: UnclassifiedIssue = {
      id,
      title: typeof row["title"] === "string" ? row["title"] : id,
      status: mapping.status,
      issueType: textOf(row["issue_type"]),
      priority: typeof row["priority"] === "number" ? row["priority"] : undefined,
      labels: labelsOf(row["labels"]),
      createdAt: textOf(row["created_at"]),
      updatedAt: textOf(row["updated_at"]),
      owner: textOf(row["assignee"]),
      reporter: textOf(row["created_by"]),
      blockedBy: blockedBy.map((link) => link.id),
      origin: originOf(row["metadata"]),
    };
    const parentId = parentIdOf(id);
    const { classification, reason } = classify(listed, {
      issues: options.issues,
      lanes: options.lanes ?? [],
      collectionComplete: options.collectionComplete,
      blockerStatus: statusOfEach(blockedBy),
      parentStatus:
        parentId === undefined
          ? undefined
          : parentChildStatuses(
              row["dependencies"],
              categories,
              (other) => other === parentId,
            ).get(parentId),
      childStatus: parentChildStatuses(row["dependents"], categories, (other) =>
        other.startsWith(id + "."),
      ),
      stored:
        mapping.parked === undefined
          ? undefined
          : new Map([[id, { classification: mapping.parked, status: stored }]]),
    });
    return {
      kind: "found",
      tried: reader.tried,
      issue: {
        id,
        title: listed.title,
        status: listed.status,
        issueType: listed.issueType,
        priority: listed.priority,
        labels: listed.labels,
        createdAt: listed.createdAt,
        updatedAt: listed.updatedAt,
        owner: listed.owner,
        reporter: listed.reporter,
        description: textOf(row["description"]),
        notes: textOf(row["notes"]),
        origin: resolveOrigin(listed, new Map(options.issues.map((issue) => [issue.id, issue]))),
        classification,
        reason,
        blockedBy,
        blocks: linksOf(row["dependents"], categories),
      },
    };
  } catch (cause) {
    return {
      kind: "unreadable",
      error: collectionError(reader.beadsDir, cause),
      tried: reader.tried,
    };
  }
}
