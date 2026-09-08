import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readSnapshot, type StateOptions } from "./state.js";

export const DEFAULT_PORT = 7373;
export const HOST = "127.0.0.1";
export const UI_DIR = fileURLToPath(new URL("../dist/ui", import.meta.url));

export interface ServeOptions extends StateOptions {
  uiDir?: string;
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
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
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
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export function createConsoleServer(options: ServeOptions = {}): Server {
  const uiDir = resolve(options.uiDir ?? UI_DIR);
  return createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
    if (pathname === "/api/snapshot") {
      serveSnapshot(res, options);
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
