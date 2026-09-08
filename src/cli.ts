#!/usr/bin/env node
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import { DEFAULT_PORT, HOST, createConsoleServer, listen, parseServeArgs } from "./serve.js";
import { VERSION } from "./version.js";

const USAGE = `pitwall ${VERSION}

  pitwall serve        serve the console on http://${HOST}:${DEFAULT_PORT}/
    --port <n>         listen on another port
  pitwall --version    print the agent and contract versions
  pitwall --help       this message
`;

export interface CommandResult {
  code: number;
  out: string;
  serve?: { port: number };
}

export function run(argv: string[]): CommandResult {
  const [arg, ...rest] = argv;
  if (arg === "--version" || arg === "-v") {
    return { code: 0, out: `pitwall ${VERSION} (snapshot contract ${SCHEMA_VERSION})\n` };
  }
  if (arg === undefined || arg === "--help" || arg === "-h") {
    return { code: 0, out: USAGE };
  }
  if (arg === "serve") {
    const parsed = parseServeArgs(rest);
    if ("error" in parsed) {
      return { code: 2, out: `pitwall serve: ${parsed.error}\n\n${USAGE}` };
    }
    return { code: 0, out: "", serve: parsed };
  }
  return { code: 2, out: `pitwall: unknown argument ${arg}\n\n${USAGE}` };
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isEntry) {
  const { code, out, serve } = run(process.argv.slice(2));
  process.stdout.write(out);
  if (serve === undefined) {
    process.exit(code);
  }
  listen(createConsoleServer(), serve.port).then(
    () => process.stdout.write(`pitwall console on http://${HOST}:${serve.port}/\n`),
    (cause: NodeJS.ErrnoException) => {
      const why = cause.code === "EADDRINUSE" ? `port ${serve.port} is already in use` : cause.message;
      process.stderr.write(`pitwall: ${why}\n`);
      process.exit(1);
    },
  );
}
