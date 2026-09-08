import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PRECONDITIONS, type PullReference, type PullState } from "./staleness.js";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

const PULL_STATES = new Map<string, PullState>([
  ["MERGED", "merged"],
  ["OPEN", "open"],
  ["CLOSED", "closed"],
]);

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface PullLookupOptions extends ProbeOptions {
  repos: ReadonlyMap<string, string>;
}

function allowed(command: readonly string[]): boolean {
  return PRECONDITIONS.some(
    (precondition) =>
      precondition.command.length === command.length &&
      precondition.command.every((token, index) => token === command[index]),
  );
}

export function preconditionProbe(
  options: ProbeOptions = {},
): (command: readonly string[]) => Promise<boolean | undefined> {
  const answers = new Map<string, Promise<boolean | undefined>>();
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
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    }).then(
      () => true,
      (cause: { code?: unknown; killed?: unknown }) =>
        cause.killed === true || typeof cause.code !== "number" ? undefined : false,
    );
    answers.set(key, asked);
    return asked;
  };
}

function locate(reference: PullReference, repos: ReadonlyMap<string, string>): string | undefined {
  const anywhere = [...repos.values()][0];
  if (reference.url !== undefined) {
    return anywhere;
  }
  if (reference.repo !== undefined) {
    return repos.get(reference.repo);
  }
  return repos.size === 1 ? anywhere : undefined;
}

export function pullLookup(
  options: PullLookupOptions,
): (reference: PullReference) => Promise<PullState | undefined> {
  const answers = new Map<string, Promise<PullState | undefined>>();
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
    const asked = run("gh", ["pr", "view", target, "--json", "state"], {
      cwd,
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: MAX_OUTPUT,
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    }).then(
      ({ stdout }) => {
        const state = (JSON.parse(stdout) as { state?: unknown }).state;
        return typeof state === "string" ? PULL_STATES.get(state) : undefined;
      },
      () => undefined,
    );
    answers.set(key, asked);
    return asked;
  };
}
