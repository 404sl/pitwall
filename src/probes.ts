import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CollectionError } from "@404sl/pitwall-schema";
import { collectionError, failureOf, recordOnce } from "./errors.js";
import {
  PRECONDITIONS,
  PULL_REFERENCE_SOURCE,
  PULL_SOURCE,
  type PullFacts,
  type PullReference,
  type PullState,
} from "./staleness.js";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;
const NO_SUCH_PULL = /Could not resolve to a PullRequest/;

const LISTED_LIMIT = 3;

const PULL_STATES = new Map<string, PullState>([
  ["MERGED", "merged"],
  ["OPEN", "open"],
  ["CLOSED", "closed"],
]);

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  errors?: CollectionError[];
}

export interface PullLookupOptions extends ProbeOptions {
  repos: ReadonlyMap<string, string>;
  names?: (text: string) => string | undefined;
}

function allowed(command: readonly string[]): boolean {
  return PRECONDITIONS.some(
    (precondition) =>
      precondition.command.length === command.length &&
      precondition.command.every((token, index) => token === command[index]),
  );
}

function unreadable(
  options: ProbeOptions,
  source: string,
  cause: unknown,
  timeoutMs: number,
): void {
  if (options.errors === undefined) {
    return;
  }
  recordOnce(options.errors, collectionError(source, failureOf(cause, timeoutMs)));
}

function answered(cause: unknown): boolean {
  const failed = cause as { killed?: unknown; stderr?: unknown } | null;
  if (failed?.killed === true || typeof failed?.stderr !== "string") {
    return false;
  }
  return NO_SUCH_PULL.test(failed.stderr);
}

export function preconditionProbe(
  options: ProbeOptions = {},
): (command: readonly string[]) => Promise<boolean | undefined> {
  const answers = new Map<string, Promise<boolean | undefined>>();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return (command) => {
    if (!allowed(command)) {
      return Promise.resolve(undefined);
    }
    const key = command.join(" ");
    const known = answers.get(key);
    if (known !== undefined) {
      return known;
    }
    const [program, ...args] = command;
    const asked = run(program as string, args, {
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: MAX_OUTPUT,
      timeout: timeoutMs,
    }).then(
      () => true,
      (cause: { code?: unknown; killed?: unknown }) => {
        if (cause.killed !== true && typeof cause.code === "number") {
          return false;
        }
        unreadable(options, key, cause, timeoutMs);
        return undefined;
      },
    );
    answers.set(key, asked);
    return asked;
  };
}

function named(
  pull: { headRefName?: unknown; body?: unknown },
  names: ((text: string) => string | undefined) | undefined,
): string | undefined {
  if (names === undefined) {
    return undefined;
  }
  const branch = typeof pull.headRefName === "string" ? names(pull.headRefName) : undefined;
  if (branch !== undefined) {
    return branch;
  }
  return typeof pull.body === "string" ? names(pull.body) : undefined;
}

function locate(reference: PullReference, repos: ReadonlyMap<string, string>): string | undefined {
  const named = reference.repo === undefined ? undefined : repos.get(reference.repo);
  if (named !== undefined) {
    return named;
  }
  const anywhere = [...repos.values()][0];
  if (reference.url !== undefined) {
    return anywhere;
  }
  return reference.repo === undefined && repos.size === 1 ? anywhere : undefined;
}

interface Unplaceable {
  bare: Set<string>;
  named: Set<string>;
  repos: Set<string>;
}

function listed(texts: ReadonlySet<string>): string {
  const all = [...texts];
  const shown = all.slice(0, LISTED_LIMIT).join(", ");
  const rest = all.length - Math.min(all.length, LISTED_LIMIT);
  return rest === 0 ? shown : `${shown}, +${rest} more`;
}

function unplaceableMessage(unplaceable: Unplaceable, repos: number): string {
  const count = unplaceable.bare.size + unplaceable.named.size;
  const clauses: string[] = [];
  if (unplaceable.bare.size > 0) {
    const verb = unplaceable.bare.size === 1 ? "names" : "name";
    clauses.push(`${listed(unplaceable.bare)} ${verb} no repository.`);
  }
  if (unplaceable.named.size > 0) {
    const verb = unplaceable.named.size === 1 ? "names" : "name";
    const missing =
      unplaceable.repos.size === 1
        ? "a repository that is not one of them."
        : "repositories that are not among them.";
    clauses.push(`${listed(unplaceable.named)} ${verb} ${missing}`);
  }
  return [
    `${count} pull ${count === 1 ? "reference" : "references"} could not be placed.`,
    `${repos} ${repos === 1 ? "repository is" : "repositories are"} configured.`,
    ...clauses,
  ].join(" ");
}

function unplaced(
  reference: PullReference,
  options: PullLookupOptions,
  unplaceable: Unplaceable,
): void {
  if (options.errors === undefined || options.repos.size === 0) {
    return;
  }
  if (reference.repo === undefined) {
    unplaceable.bare.add(reference.text);
  } else {
    unplaceable.named.add(reference.text);
    unplaceable.repos.add(reference.repo);
  }
  const message = unplaceableMessage(unplaceable, options.repos.size);
  const index = options.errors.findIndex((error) => error.source === PULL_REFERENCE_SOURCE);
  const known = index === -1 ? undefined : options.errors[index];
  if (known === undefined) {
    recordOnce(options.errors, collectionError(PULL_REFERENCE_SOURCE, message));
    return;
  }
  options.errors[index] = { ...known, message };
}

async function viewed(
  target: string,
  cwd: string,
  options: PullLookupOptions,
  timeoutMs: number,
): Promise<PullFacts | undefined> {
  try {
    const { stdout } = await run("gh", ["pr", "view", target, "--json", "state,headRefName,body"], {
      cwd,
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: MAX_OUTPUT,
      timeout: timeoutMs,
    });
    const viewedPull = JSON.parse(stdout) as {
      state?: unknown;
      headRefName?: unknown;
      body?: unknown;
    };
    const state = typeof viewedPull.state === "string" ? PULL_STATES.get(viewedPull.state) : undefined;
    if (state === undefined) {
      return undefined;
    }
    return { state, issueId: named(viewedPull, options.names) };
  } catch (cause) {
    if (!answered(cause)) {
      unreadable(options, PULL_SOURCE, cause, timeoutMs);
    }
    return undefined;
  }
}

export function pullLookup(
  options: PullLookupOptions,
): (reference: PullReference) => Promise<PullFacts | undefined> {
  const answers = new Map<string, Promise<PullFacts | undefined>>();
  const unplaceable: Unplaceable = { bare: new Set(), named: new Set(), repos: new Set() };
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return (reference) => {
    const cwd = locate(reference, options.repos);
    if (cwd === undefined) {
      unplaced(reference, options, unplaceable);
      return Promise.resolve(undefined);
    }
    const target = reference.url ?? String(reference.number);
    const key = `${cwd} ${target}`;
    const known = answers.get(key);
    if (known !== undefined) {
      return known;
    }
    const asked = viewed(target, cwd, options, timeoutMs);
    answers.set(key, asked);
    return asked;
  };
}
