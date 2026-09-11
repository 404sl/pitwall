#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import { diagnose, renderDoctor } from "./doctor.js";
import { DEFAULT_PORT, HOST, consoleAnnouncer, consoleCollector, createConsoleServer, listen, parseServeArgs } from "./serve.js";
import { undeliveredReport } from "./notify.js";
import { emitSnapshot } from "./snapshot.js";
import { readSnapshot, readSnapshotFrom, snapshotPath } from "./state.js";
import { upstreamReport } from "./upstream.js";
import { missingSnapshotMessage, parseStatusArgs, renderStatus, terminalWidth, wantsColor } from "./status.js";
import { VERSION } from "./version.js";

const USAGE = `pitwall ${VERSION}

  pitwall status       print the latest snapshot as one screen
    --from <path>      read the snapshot from this file instead of the state path
  pitwall snapshot     collect every project and print the snapshot as JSON
  pitwall doctor       check every source a snapshot reads and say what is wrong
  pitwall serve        serve the console on http://${HOST}:${DEFAULT_PORT}/
    --port <n>         listen on another port
  pitwall --version    print the agent and contract versions
  pitwall --help       this message

Run the current release with npx @404sl/pitwall@latest.
`;

export interface CommandResult {
  code: number;
  out: string;
  serve?: { port: number };
  doctor?: true;
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
  if (arg === "doctor") {
    if (rest.length > 0) {
      return { code: 2, out: `pitwall doctor: unknown argument ${rest[0]}\n\n${USAGE}` };
    }
    return { code: 0, out: "", doctor: true };
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

function quitQuietlyOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EPIPE") {
      throw cause;
    }
    process.exit(0);
  });
}

// WAS THIS FILE RUN, OR IMPORTED? Compare RESOLVED PATHS, not names.
//
// This used to ask whether import.meta.url ended with the basename of argv[1], which is true
// when you run `node dist/cli.js` and FALSE for every installed copy: npm links the binary as
// `pitwall`, so argv[1] ends "pitwall" while this module is still "cli.js". The guard failed,
// nothing ran, and the process exited 0 - silently, with no output and no error.
//
// It survived local testing because locally you invoke the file by its own name. Every
// published version before 0.1.2 did nothing at all when installed.
const isEntry = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  quitQuietlyOnBrokenPipe(process.stdout);
  quitQuietlyOnBrokenPipe(process.stderr);
  const { code, doctor, out, serve, snapshot, status } = run(process.argv.slice(2));
  process.stdout.write(out);
  if (doctor !== undefined) {
    diagnose().then(
      (diagnosis) => {
        process.stdout.write(
          renderDoctor(diagnosis, { color: wantsColor(process.env, process.stdout.isTTY === true) }),
        );
        process.exitCode = diagnosis.code;
      },
      (cause: Error) => {
        process.stderr.write(`pitwall doctor: ${cause.message}\n`);
        process.exitCode = 1;
      },
    );
  } else if (snapshot !== undefined) {
    emitSnapshot().then(
      (result) => {
        process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
        for (const line of undeliveredReport(result.delivered)) {
          process.stderr.write(`pitwall snapshot: ${line}\n`);
        }
        for (const line of upstreamReport(result.upstream)) {
          process.stderr.write(`pitwall snapshot: ${line}\n`);
        }
        for (const unlisted of result.unlisted) {
          process.stderr.write(`pitwall snapshot: ${unlisted.message}\n`);
        }
        if (!result.read) {
          process.stderr.write(
            `pitwall snapshot: nothing could be read, so ${snapshotPath()} was left as it was\n`,
          );
        }
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
    listen(
      createConsoleServer({ collect: consoleCollector(), announce: consoleAnnouncer() }),
      serve.port,
    ).then(
      () => process.stdout.write(`pitwall console on http://${HOST}:${serve.port}/\n`),
      (cause: NodeJS.ErrnoException) => {
        const why = cause.code === "EADDRINUSE" ? `port ${serve.port} is already in use` : cause.message;
        process.stderr.write(`pitwall: ${why}\n`);
        process.exit(1);
      },
    );
  }
}
