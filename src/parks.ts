import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CollectionError, Issue, Stopped } from "@404sl/pitwall-schema";
import type { IssueText } from "./beads.js";
import type { ProjectQuestions, QuestionStore } from "./board.js";
import { parkLabelOf } from "./classify.js";
import { collectionError } from "./errors.js";
import { lastNote, withoutStampLines } from "./staleness.js";
import { stateHome, type StateOptions } from "./state.js";

export interface ConsoleState {
  questions: QuestionStore;
}

export interface StoredConsole {
  path: string;
  state: ConsoleState;
  error?: CollectionError;
}

export function consolePath(options: StateOptions = {}): string {
  return join(stateHome(options), "pitwall", "console.json");
}

function projectQuestionsOf(value: unknown): ProjectQuestions {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const questions: ProjectQuestions = {};
  for (const [id, question] of Object.entries(value as Record<string, unknown>)) {
    if (typeof question === "string") {
      questions[id] = question;
    }
  }
  return questions;
}

function storeOf(value: unknown): QuestionStore {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const questions = (value as { questions?: unknown }).questions;
  if (typeof questions !== "object" || questions === null) {
    return {};
  }
  const store: QuestionStore = {};
  for (const [project, entries] of Object.entries(questions as Record<string, unknown>)) {
    store[project] = projectQuestionsOf(entries);
  }
  return store;
}

function isAbsent(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "ENOENT";
}

export function readConsoleState(options: StateOptions = {}): StoredConsole {
  const path = consolePath(options);
  try {
    return { path, state: { questions: storeOf(JSON.parse(readFileSync(path, "utf8"))) } };
  } catch (cause) {
    return isAbsent(cause)
      ? { path, state: { questions: {} } }
      : { path, state: { questions: {} }, error: collectionError(path, cause) };
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

export function stoppedOf(
  issue: Pick<Issue, "classification" | "labels">,
  previous: Pick<Issue, "classification" | "labels" | "stopped"> | undefined,
  at: string,
): Stopped | undefined {
  const label = parkLabelOf(issue);
  if (label === undefined) {
    return undefined;
  }
  if (previous?.stopped !== undefined && parkLabelOf(previous) === label) {
    return { since: previous.stopped.since, basis: "carried" };
  }
  return { since: at, basis: "first-seen" };
}

export function withStopped(issues: readonly Issue[], previous: readonly Issue[] | undefined, at: string): Issue[] {
  const before = new Map((previous ?? []).map((issue) => [issue.id, issue]));
  return issues.map((issue) => {
    const stopped = stoppedOf(issue, before.get(issue.id), at);
    return stopped === undefined ? issue : { ...issue, stopped };
  });
}

export function questionsFor(issues: readonly Issue[], texts: ReadonlyMap<string, IssueText>): ProjectQuestions {
  const questions: ProjectQuestions = {};
  for (const issue of issues) {
    if (issue.classification !== "yours:decision" || parkLabelOf(issue) === undefined) {
      continue;
    }
    const text = texts.get(issue.id);
    const question = questionOf({ title: issue.title, description: text?.description, notes: text?.notes });
    if (question !== undefined) {
      questions[issue.id] = question;
    }
  }
  return questions;
}
