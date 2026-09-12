import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CollectionError } from "@404sl/pitwall-schema";
import { collectionError, failureOf, recordOnce } from "./errors.js";
import { PRECONDITIONS } from "./staleness.js";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  errors?: CollectionError[];
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
