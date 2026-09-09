#!/usr/bin/env node
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import { DEFAULT_PORT, HOST, createConsoleServer, listen, parseServeArgs } from "./serve.js";
import { emitSnapshot } from "./snapshot.js";
import { readSnapshot, readSnapshotFrom } from "./state.js";
import { missingSnapshotMessage, parseStatusArgs, renderStatus, terminalWidth, wantsColor } from "./status.js";
import { VERSION } from "./version.js";

const USAGE = `pitwall ${VERSION}

  pitwall status       print the latest snapshot as one screen
    --from <path>      read the snapshot from this file instead of the state path
  pitwall snapshot     collect every project and print the snapshot as JSON
  pitwall serve        serve the console on http://${HOST}:${DEFAULT_PORT}/
    --port <n>         listen on another port
  pitwall --version    print the agent and contract versions
  pitwall --help       this message
`;

export interface CommandResult {
  code: number;
  out: string;
  serve?: { port: number };
  snapshot?: true;
  status?: { from?: string };
}

export function run(argv: string[]): CommandResult {
  const [arg, ...rest] = argv;
  if (arg === "--version" || arg === "-v") {
    return { code: 0, out: `pitwall ${VERSION} (snapshot contract ${SCHEMA_VERSION})\n` };
  }
  if (arg === undefined || arg === "--help" || arg === "-h") {
    return { code: 0, out: USAGE };
  }
  if (arg === "status") {
    const parsed = parseStatusArgs(rest);
    if ("error" in parsed) {
      return { code: 2, out: `pitwall status: ${parsed.error}\n\n${USAGE}` };
    }
    return { code: 0, out: "", status: parsed };
  }
  if (arg === "snapshot") {
    if (rest.length > 0) {
      return { code: 2, out: `pitwall snapshot: unknown argument ${rest[0]}\n\n${USAGE}` };
    }
    return { code: 0, out: "", snapshot: true };
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
  const { code, out, serve, snapshot, status } = run(process.argv.slice(2));
  process.stdout.write(out);
  if (snapshot !== undefined) {
    emitSnapshot().then(
      (result) => {
        process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
        process.exitCode = result.code;
      },
      (cause: Error) => {
        process.stderr.write(`pitwall snapshot: ${cause.message}\n`);
        process.exitCode = 1;
      },
    );
  } else if (status !== undefined) {
    const { from } = status;
    const stored = from === undefined ? readSnapshot() : readSnapshotFrom(from);
    if (stored.snapshot === undefined) {
      process.stderr.write(`pitwall status: ${missingSnapshotMessage(stored.error)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        renderStatus(stored.snapshot, {
          color: wantsColor(process.env, process.stdout.isTTY === true),
          width: terminalWidth(process.stdout),
          fromFile: from !== undefined,
        }),
      );
    }
  } else if (serve === undefined) {
    process.exit(code);
  } else {
    listen(createConsoleServer(), serve.port).then(
      () => process.stdout.write(`pitwall console on http://${HOST}:${serve.port}/\n`),
      (cause: NodeJS.ErrnoException) => {
        const why = cause.code === "EADDRINUSE" ? `port ${serve.port} is already in use` : cause.message;
        process.stderr.write(`pitwall: ${why}\n`);
        process.exit(1);
      },
    );
  }
}
