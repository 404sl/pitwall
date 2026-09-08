import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Issue, Project, Snapshot } from "@404sl/pitwall-schema";
import { readWorkspace } from "./autofix.js";
import { readIssue } from "./beads.js";
import { readSnapshot, type StateOptions } from "./state.js";

export const DEFAULT_PORT = 7373;
export const HOST = "127.0.0.1";
export const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
export const UI_DIR = fileURLToPath(new URL("../dist/ui", import.meta.url));
export const ISSUE_PREFIX = "/api/issue/";

export interface ServeOptions extends StateOptions {
  uiDir?: string;
  lockRoot?: string;
  timeoutMs?: number;
}

export type ServeArgs = { port: number } | { error: string };

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function parseServeArgs(argv: string[]): ServeArgs {
  const tokens = argv.flatMap((arg) =>
    arg.startsWith("--port=") ? ["--port", arg.slice("--port=".length)] : [arg],
  );
  let port = DEFAULT_PORT;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== "--port") {
      return { error: `unknown argument ${token}` };
    }
    const value = tokens[i + 1];
    const parsed = Number(value);
    if (value === undefined || value === "" || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { error: `--port expects a number between 1 and 65535, got ${value ?? "nothing"}` };
    }
    port = parsed;
    i += 1;
  }
  return { port };
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(body));
}

function serveSnapshot(res: ServerResponse, options: ServeOptions): void {
  const stored = readSnapshot(options);
  if (stored.snapshot !== undefined) {
    sendJson(res, 200, stored.snapshot);
    return;
  }
  const { error } = stored;
  sendJson(res, 503, {
    message: `No snapshot to show yet - ${error.source} could not be read: ${error.message}`,
    source: error.source,
    at: error.at,
  });
}

function issueRoute(pathname: string): { project: string; id: string } | undefined {
  const segments = pathname.slice(ISSUE_PREFIX.length).split("/");
  if (segments.length !== 2) {
    return undefined;
  }
  try {
    const [project, id] = segments.map((segment) => decodeURIComponent(segment));
    return project === undefined || project === "" || id === undefined || id === ""
      ? undefined
      : { project, id };
  } catch {
    return undefined;
  }
}

function snapshotIssue(project: Project | undefined, id: string): Issue | undefined {
  return project?.issues.find((issue) => issue.id === id);
}

function projectIn(snapshot: Snapshot, id: string): Project | undefined {
  return snapshot.projects.find((project) => project.id === id);
}

async function serveIssue(
  res: ServerResponse,
  options: ServeOptions,
  route: { project: string; id: string },
): Promise<void> {
  const stored = readSnapshot(options);
  if (stored.snapshot === undefined) {
    sendJson(res, 503, {
      message: `${route.id} cannot be looked up - ${stored.error.source} could not be read: ${stored.error.message}`,
      source: stored.error.source,
      tried: [stored.path],
    });
    return;
  }
  const indexed = projectIn(stored.snapshot, route.project);
  if (indexed === undefined) {
    sendJson(res, 503, {
      message: `${route.id} cannot be looked up - the snapshot names no project ${route.project}`,
      source: stored.path,
      tried: [stored.path],
    });
    return;
  }
  const project = readWorkspace(indexed.root, { lockRoot: options.lockRoot });
  const reading = await readIssue(indexed.root, route.id, {
    env: options.env,
    lanes: project.lanes,
    errors: project.errors,
    timeoutMs: options.timeoutMs,
  });
  if (reading.kind === "unreadable") {
    sendJson(res, 503, {
      message: `${route.id} could not be read: ${reading.error.message}`,
      source: reading.error.source,
      tried: [reading.error.source, ...reading.tried],
    });
    return;
  }
  if (reading.kind === "missing") {
    sendJson(res, 404, {
      message: `${indexed.name} has no issue ${route.id}`,
      project: indexed.name,
      id: route.id,
    });
    return;
  }
  const snapshotStatus = snapshotIssue(indexed, route.id);
  sendJson(res, 200, {
    issue: {
      ...reading.issue,
      project: indexed.id,
      projectName: indexed.name,
      authority: project.authority,
      staleness: snapshotStatus?.staleness ?? { verdict: "unchecked", evidence: [] },
    },
    readAt: new Date().toISOString(),
    snapshot:
      snapshotStatus === undefined
        ? undefined
        : { generatedAt: stored.snapshot.generatedAt, status: snapshotStatus.status },
  });
}

function fileFor(uiDir: string, pathname: string): string | undefined {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return undefined;
  }
  const file = resolve(uiDir, relative === "" ? "index.html" : relative);
  if (file !== uiDir && !file.startsWith(uiDir + sep)) {
    return undefined;
  }
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

function sendFile(res: ServerResponse, file: string): void {
  const stream = createReadStream(file);
  let open = false;
  stream.once("open", () => {
    open = true;
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    pipeline(stream, res, () => {});
  });
  stream.once("error", (cause: NodeJS.ErrnoException) => {
    if (open) {
      return;
    }
    stream.destroy();
    send(res, 500, "text/plain; charset=utf-8", `Could not read ${file}: ${cause.message}\n`);
  });
}

function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d*$/, "");
  return LOCAL_HOSTNAMES.includes(name);
}

function serveConsole(res: ServerResponse, uiDir: string, pathname: string): void {
  if (!existsSync(uiDir)) {
    send(
      res,
      503,
      "text/plain; charset=utf-8",
      `The console has not been built - there is nothing at ${uiDir}. Run \`npm run build:ui\`.\n`,
    );
    return;
  }
  const file = fileFor(uiDir, pathname);
  if (file === undefined) {
    send(res, 404, "text/plain; charset=utf-8", `Not found: ${pathname}\n`);
    return;
  }
  sendFile(res, file);
}

export function createConsoleServer(options: ServeOptions = {}): Server {
  const uiDir = resolve(options.uiDir ?? UI_DIR);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalHost(req.headers.host)) {
      send(res, 403, "text/plain; charset=utf-8", "The console answers requests addressed to localhost only.\n");
      return;
    }
    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
    if (pathname === "/api/snapshot") {
      serveSnapshot(res, options);
      return;
    }
    if (pathname.startsWith(ISSUE_PREFIX)) {
      const route = issueRoute(pathname);
      if (route === undefined) {
        send(res, 404, "text/plain; charset=utf-8", `Not found: ${pathname}\n`);
        return;
      }
      void serveIssue(res, options, route).catch((cause: unknown) => {
        sendJson(res, 503, {
          message: `${route.id} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          source: pathname,
          tried: [pathname],
        });
      });
      return;
    }
    serveConsole(res, uiDir, pathname);
  });
}

export function listen(server: Server, port: number): Promise<Server> {
  return new Promise((done, failed) => {
    const onError = (cause: Error) => failed(cause);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.removeListener("error", onError);
      done(server);
    });
  });
}
