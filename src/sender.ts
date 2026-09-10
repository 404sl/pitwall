import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKSPACE_FILES, workspaceFile } from "./autofix.js";
import type { Delivery, Sender } from "./notify.js";

export const SESSION_REF_VAR = "PITWALL_SESSION_REF";
export const NOTIFY_FIELD = "notify";
export const SESSION_REF_FIELD = "sessionRef";

const TIMEOUT_MS = 20_000;
const MAX_REASON = 1000;

export interface TransportOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  sessionRef?: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function workspaceOf(root: string): Record<string, unknown> {
  const found = workspaceFile(resolve(root));
  if (found === undefined) {
    throw new Error(`there is no ${WORKSPACE_FILES.join(" or ")} in ${resolve(root)}`);
  }
  const parsed = JSON.parse(readFileSync(found.path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${found.path} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

export function sessionRefOf(root: string, options: TransportOptions = {}): string | undefined {
  const named = (options.env ?? process.env)[SESSION_REF_VAR];
  if (typeof named === "string" && named !== "") {
    return named;
  }
  let configured: unknown;
  try {
    configured = workspaceOf(root)[SESSION_REF_FIELD];
  } catch {
    return undefined;
  }
  return typeof configured === "string" && configured !== "" ? configured : undefined;
}

type Command = { command: string[] } | { reason: string };

export function notifyCommandOf(root: string): Command {
  let configured: unknown;
  try {
    configured = workspaceOf(root)[NOTIFY_FIELD];
  } catch (cause) {
    return { reason: `the workspace file could not be read: ${messageOf(cause)}` };
  }
  if (configured === undefined) {
    return {
      reason: `no ${NOTIFY_FIELD} command is configured in the workspace file in ${resolve(root)}`,
    };
  }
  if (
    !Array.isArray(configured) ||
    configured.length === 0 ||
    configured.some((word) => typeof word !== "string" || word === "")
  ) {
    return {
      reason: `${NOTIFY_FIELD} in the workspace file in ${resolve(root)} is not a command: it must be a non-empty array of words, the first of them the program`,
    };
  }
  return { command: configured as string[] };
}

function reasonOf(
  program: string,
  code: number | null,
  signal: string | null,
  said: string,
): string {
  const how = signal === null ? `exited ${code ?? "without a status"}` : `was killed by ${signal}`;
  const reported = said.trim().slice(0, MAX_REASON);
  return reported === "" ? `${program} ${how} and said nothing` : `${program} ${how}: ${reported}`;
}

export function commandSender(command: readonly string[], options: CommandOptions = {}): Sender {
  const program = command[0] ?? "";
  const args = command.slice(1);
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return (notice) =>
    new Promise<Delivery>((settle) => {
      let child: ChildProcess;
      try {
        child = spawn(program, args, {
          cwd: options.cwd,
          env,
          stdio: ["pipe", "ignore", "pipe"],
        });
      } catch (cause) {
        settle({ delivered: false, reason: `${program} could not be run: ${messageOf(cause)}` });
        return;
      }
      let said = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ delivered: false, reason: `${program} did not answer within ${timeoutMs}ms` });
      }, timeoutMs);
      function finish(delivery: Delivery): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        settle(delivery);
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        if (said.length < MAX_REASON) {
          said += chunk.toString("utf8");
        }
      });
      child.stdin?.on("error", () => undefined);
      child.on("error", (cause) => {
        finish({ delivered: false, reason: `${program} could not be run: ${cause.message}` });
      });
      child.on("close", (code, signal) => {
        if (code === 0) {
          finish({ delivered: true });
          return;
        }
        finish({ delivered: false, reason: reasonOf(program, code, signal, said) });
      });
      child.stdin?.end(`${JSON.stringify(notice)}\n`);
    });
}

function holding(reason: string): Sender {
  return () => Promise.resolve({ delivered: false, reason });
}

export function workspaceSender(root: string, options: TransportOptions = {}): Sender {
  if (options.sessionRef === undefined || options.sessionRef === "") {
    const where = `${SESSION_REF_VAR} is not set and the workspace file in ${resolve(root)} names no ${SESSION_REF_FIELD}`;
    return holding(
      `${where}, so this collection cannot tell its own work from another session's and holds every notice`,
    );
  }
  const found = notifyCommandOf(root);
  if ("reason" in found) {
    return holding(found.reason);
  }
  return commandSender(found.command, {
    cwd: resolve(root),
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
}
