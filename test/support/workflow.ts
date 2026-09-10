import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dirname, "..", "..", "plugins", "devloop", "skills", "devloop");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export type Call = { prompt: string; label: string; schema?: any };
export type Reply = (call: Call, n: number) => unknown;

export function runScript(file: string, args: unknown, reply: Reply) {
  const source = readFileSync(join(SKILL, file), "utf8").replace(/^export const /m, "const ");
  const calls: Call[] = [];
  const logs: string[] = [];
  const body = new AsyncFunction("args", "agent", "phase", "log", "parallel", source);
  const agent = async (prompt: string, opts: { label?: string; schema?: unknown } = {}) => {
    const call = { prompt, label: opts.label || "", schema: opts.schema };
    calls.push(call);
    return reply(call, calls.length);
  };
  const noop = () => {};
  const log = (line: unknown) => {
    logs.push(String(line));
  };
  return { calls, logs, done: body(args, agent, noop, log, noop) as Promise<Record<string, unknown>> };
}
