#!/usr/bin/env node
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import { VERSION } from "./version.js";

const USAGE = `pitwall ${VERSION}

  pitwall --version    print the agent and contract versions
  pitwall --help       this message

Nothing else is wired up yet.
`;

export function run(argv: string[]): { code: number; out: string } {
  const [arg] = argv;
  if (arg === "--version" || arg === "-v") {
    return { code: 0, out: `pitwall ${VERSION} (snapshot contract ${SCHEMA_VERSION})\n` };
  }
  if (arg === undefined || arg === "--help" || arg === "-h") {
    return { code: 0, out: USAGE };
  }
  return { code: 2, out: `pitwall: unknown argument ${arg}\n\n${USAGE}` };
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isEntry) {
  const { code, out } = run(process.argv.slice(2));
  process.stdout.write(out);
  process.exit(code);
}
