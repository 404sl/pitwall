import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CollectionError } from "@404sl/pitwall-schema";
import { collectionError, failureOf, recordOnce } from "./errors.js";
import { PRECONDITIONS, type PullFacts, type PullReference, type PullState } from "./staleness.js";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;
const PULL_SOURCE = "gh pr view";
const NO_SUCH_PULL = /Could not resolve to a PullRequest/;

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
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return (reference) => {
    const cwd = locate(reference, options.repos);
    if (cwd === undefined) {
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
