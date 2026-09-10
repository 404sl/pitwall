import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Classification, CollectionError, Issue, Project, Snapshot } from "@404sl/pitwall-schema";
import { REFRESH_SOURCE, stalenessErrors } from "./board.js";
import {
  IssueActionFailure,
  OWNER_LABELS,
  collectionFailed,
  issueActor,
  readIssue,
  type IssueReading,
} from "./beads.js";
import { createBuildCheck, type BuildCheck } from "./build.js";
import { collectionError } from "./errors.js";
import { lostNotices } from "./notify.js";
import { createUpdateCheck, type UpdateCheck } from "./registry.js";
import { emitSnapshot, type SnapshotOptions } from "./snapshot.js";
import { readSnapshot, type StateOptions, type StoredSnapshot } from "./state.js";
import { VERSION } from "./version.js";

export const DEFAULT_PORT = 7373;
export const HOST = "127.0.0.1";
export const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
export const UI_DIR = fileURLToPath(new URL("../dist/ui", import.meta.url));
export const ISSUE_PREFIX = "/api/issue/";
export const VERSION_ROUTE = "/api/version";
export const REFRESH_FLOOR_MS = 60_000;
export const NOTHING_READ = "No project could be read. The board still shows the last snapshot collected.";
const NOTHING_READ_YET = "The last collection could read no project either";
const REFRESH_FAILED_TOO = "The last collection failed too";

export interface Collection {
  read: boolean;
  errors: readonly CollectionError[];
}

export type Collector = () => Promise<Collection>;

export interface ServeOptions extends StateOptions {
  uiDir?: string;
  timeoutMs?: number;
  updates?: UpdateCheck;
  builds?: BuildCheck;
  collect?: Collector;
  refreshFloorMs?: number;
  now?: () => number;
}

export function consoleCollector(options: SnapshotOptions = {}): Collector {
  return async () => {
    const { snapshot, read, delivered, unlisted } = await emitSnapshot(options);
    return {
      read,
      errors: [
        ...snapshot.errors,
        ...snapshot.projects.flatMap((project) => project.errors),
        ...lostNotices(delivered),
        ...unlisted,
      ],
    };
  };
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

interface RefreshFailure {
  cause: string;
  nothingRead: boolean;
  at: string;
}

interface Refresher {
  consider: (stored: StoredSnapshot) => void;
  failure: () => RefreshFailure | undefined;
}

function causeOf(errors: readonly CollectionError[]): string {
  const first = errors[0];
  return first === undefined ? "" : `${first.source}: ${first.message}`;
}

function refreshFailure(cause: unknown, nothingRead: boolean): RefreshFailure {
  const { message, at } = collectionError(REFRESH_SOURCE, cause);
  return { cause: message, nothingRead, at };
}

function messageWithBoard(failure: RefreshFailure): string {
  if (!failure.nothingRead) {
    return failure.cause;
  }
  return failure.cause === "" ? NOTHING_READ : `${NOTHING_READ} ${failure.cause}`;
}

function messageWithoutBoard(failure: RefreshFailure): string {
  const lead = failure.nothingRead ? NOTHING_READ_YET : REFRESH_FAILED_TOO;
  return failure.cause === "" ? `${lead}.` : `${lead}: ${failure.cause}`;
}

function started(collect: Collector): Promise<Collection> {
  try {
    return collect();
  } catch (cause) {
    return Promise.reject(cause);
  }
}

function ageOf(stored: StoredSnapshot, nowMs: number): number {
  if (stored.snapshot === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const at = new Date(stored.snapshot.generatedAt).getTime();
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - at);
}

export function createRefresher(options: ServeOptions): Refresher {
  const { collect } = options;
  const floor = options.refreshFloorMs ?? REFRESH_FLOOR_MS;
  const clock = options.now ?? Date.now;
  let attemptedAt: number | undefined;
  let running = false;
  let failure: RefreshFailure | undefined;
  return {
    failure: () => failure,
    consider: (stored: StoredSnapshot) => {
      if (collect === undefined || running) {
        return;
      }
      const at = clock();
      if (attemptedAt !== undefined && at - attemptedAt < floor) {
        return;
      }
      if (ageOf(stored, at) < floor) {
        return;
      }
      attemptedAt = at;
      running = true;
      void started(collect)
        .then(
          (collection) => {
            failure = collection.read ? undefined : refreshFailure(causeOf(collection.errors), true);
          },
          (cause: unknown) => {
            failure = refreshFailure(cause, false);
          },
        )
        .finally(() => {
          running = false;
        });
    },
  };
}

function withRefreshFailure(snapshot: Snapshot, failure: RefreshFailure | undefined): Snapshot {
  if (failure === undefined) {
    return snapshot;
  }
  const error: CollectionError = {
    source: REFRESH_SOURCE,
    message: messageWithBoard(failure),
    at: failure.at,
  };
  return { ...snapshot, errors: [...(snapshot.errors ?? []), error] };
}

function serveSnapshot(res: ServerResponse, options: ServeOptions, refresher: Refresher): void {
  const stored = readSnapshot(options);
  refresher.consider(stored);
  if (stored.snapshot !== undefined) {
    sendJson(res, 200, withRefreshFailure(stored.snapshot, refresher.failure()));
    return;
  }
  const { error } = stored;
  const failure = refresher.failure();
  const read = `No snapshot to show yet - ${error.source} could not be read: ${error.message}`;
  sendJson(res, 503, {
    message: failure === undefined ? read : `${read} ${messageWithoutBoard(failure)}`,
    source: error.source,
    at: error.at,
  });
}

function serveVersion(res: ServerResponse, updates: UpdateCheck, builds: BuildCheck): void {
  const update = updates.update();
  sendJson(res, 200, {
    running: VERSION,
    ...(update === undefined ? {} : { update }),
    ...builds.state(),
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

function readIndexedIssue(
  indexed: Project,
  id: string,
  options: ServeOptions,
): Promise<IssueReading> {
  return readIssue(indexed.root, id, {
    env: options.env,
    lanes: indexed.lanes,
    issues: indexed.issues,
    collectionComplete: !collectionFailed(indexed.root, indexed.errors),
    timeoutMs: options.timeoutMs,
  });
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
  const reading = await readIndexedIssue(indexed, route.id, options);
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
      authority: indexed.authority,
      staleness: snapshotStatus?.staleness ?? { verdict: "unchecked", evidence: [] },
    },
    readAt: new Date().toISOString(),
    errors: stalenessErrors(indexed, route.id),
    snapshot:
      snapshotStatus === undefined
        ? undefined
        : { generatedAt: stored.snapshot.generatedAt, status: snapshotStatus.status },
  });
}

export function sendIssueFailure(
  res: ServerResponse,
  pathname: string,
  route: { project: string; id: string },
  cause: unknown,
): void {
  const message = `${route.id} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  if (res.headersSent) {
    process.stderr.write(`pitwall serve: ${message}, after the response had gone out\n`);
    return;
  }
  sendJson(res, 503, { message, source: pathname, tried: [pathname] });
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

export const ACTION_HEADER = "x-pitwall-action";
export const ACTIONS = ["answer", "ready", "not-mine"] as const;
export type ActionName = (typeof ACTIONS)[number];
const MAX_BODY = 16_384;
const SAME_ORIGIN = "same-origin";

function actionRoute(pathname: string): { project: string; id: string; action: ActionName } | undefined {
  const segments = pathname.slice(ISSUE_PREFIX.length).split("/");
  if (segments.length !== 3) {
    return undefined;
  }
  let project: string;
  let id: string;
  let action: string;
  try {
    [project, id, action] = segments.map((segment) => decodeURIComponent(segment)) as [string, string, string];
  } catch {
    return undefined;
  }
  if (project === "" || id === "") {
    return undefined;
  }
  const named = ACTIONS.find((candidate) => candidate === action);
  return named === undefined ? undefined : { project, id, action: named };
}

function sameOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function refusalOf(req: IncomingMessage): string | undefined {
  if (req.headers[ACTION_HEADER] === undefined) {
    return `it carried no ${ACTION_HEADER} header`;
  }
  const { origin } = req.headers;
  if (origin !== undefined && !sameOrigin(origin, req.headers.host)) {
    return `it came from ${origin}`;
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== SAME_ORIGIN) {
    return `the browser reported it as ${site}`;
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, failed) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        failed(new Error(`it is longer than ${String(MAX_BODY)} bytes`));
        req.destroy();
      }
    });
    req.on("end", () => done(body));
    req.on("error", (cause: Error) => failed(cause));
  });
}

function textIn(body: string): string {
  if (body === "") {
    return "";
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null) {
    return "";
  }
  const value = (parsed as { text?: unknown }).text;
  return typeof value === "string" ? value.trim() : "";
}

function noteFor(action: ActionName, text: string, classification: Classification): string {
  if (action === "answer") {
    return `Answered from the console: ${text}`;
  }
  if (action === "not-mine") {
    return `Not mine — the console classified this ${classification}. Reason: ${text}`;
  }
  return "Marked ready from the console.";
}

function missingText(action: ActionName, id: string): string | undefined {
  if (action === "answer") {
    return `${id} was not changed - an answer needs the answer itself, and this request carried none.`;
  }
  if (action === "not-mine") {
    return `${id} was not changed - say why it is not yours, so the next reader knows.`;
  }
  return undefined;
}

async function serveAction(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServeOptions,
  route: { project: string; id: string; action: ActionName },
): Promise<void> {
  const refusal = refusalOf(req);
  if (refusal !== undefined) {
    sendJson(res, 403, {
      message: `${route.id} was not changed - ${refusal}, so it was not sent by the console. A console action must carry the ${ACTION_HEADER} header and come from the console's own origin.`,
      id: route.id,
      action: route.action,
    });
    return;
  }
  let text: string;
  try {
    text = textIn(await readBody(req));
  } catch (cause) {
    sendJson(res, 400, {
      message: `${route.id} was not changed - the request body could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      id: route.id,
      action: route.action,
    });
    return;
  }
  const missing = text === "" ? missingText(route.action, route.id) : undefined;
  if (missing !== undefined) {
    sendJson(res, 400, { message: missing, id: route.id, action: route.action });
    return;
  }
  const stored = readSnapshot(options);
  if (stored.snapshot === undefined) {
    sendJson(res, 503, {
      message: `${route.id} was not changed - ${stored.error.source} could not be read: ${stored.error.message}`,
      source: stored.error.source,
      tried: [stored.path],
    });
    return;
  }
  const indexed = projectIn(stored.snapshot, route.project);
  if (indexed === undefined) {
    sendJson(res, 503, {
      message: `${route.id} was not changed - the snapshot names no project ${route.project}`,
      source: stored.path,
      tried: [stored.path],
    });
    return;
  }
  const reading = await readIndexedIssue(indexed, route.id, options);
  if (reading.kind === "unreadable") {
    sendJson(res, 503, {
      message: `${route.id} was not changed - it could not be read first: ${reading.error.message}`,
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
  const { classification } = reading.issue;
  if (classification === undefined) {
    sendJson(res, 400, {
      message: `${route.id} was not changed - it is closed, and the console acts on open work only.`,
      id: route.id,
      action: route.action,
    });
    return;
  }
  const note = noteFor(route.action, text, classification);
  const removedLabels = [...OWNER_LABELS];
  const act = issueActor(indexed.root, { env: options.env, timeoutMs: options.timeoutMs });
  try {
    await act(route.id, { note, removeLabels: removedLabels });
  } catch (cause) {
    const failed = cause instanceof Error ? cause.message : String(cause);
    const noted = cause instanceof IssueActionFailure && cause.noted;
    sendJson(res, 502, {
      message: noted
        ? `${route.id} carries the note but is still parked - the labels were not cleared: ${failed}`
        : `${route.id} was not changed - ${failed}`,
      id: route.id,
      action: route.action,
      noted,
    });
    return;
  }
  sendJson(res, 200, {
    id: route.id,
    action: route.action,
    project: indexed.id,
    classification,
    note,
    removedLabels,
  });
}

export function sendActionFailure(
  res: ServerResponse,
  route: { id: string; action: ActionName },
  cause: unknown,
): void {
  const message = `${route.id} may or may not have changed - the action failed after it began: ${cause instanceof Error ? cause.message : String(cause)}`;
  if (res.headersSent) {
    process.stderr.write(`pitwall serve: ${message}, after the response had gone out\n`);
    return;
  }
  sendJson(res, 500, { message, id: route.id, action: route.action });
}

export function createConsoleServer(options: ServeOptions = {}): Server {
  const uiDir = resolve(options.uiDir ?? UI_DIR);
  const updates = options.updates ?? createUpdateCheck();
  const builds = options.builds ?? createBuildCheck();
  const refresher = createRefresher(options);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalHost(req.headers.host)) {
      send(res, 403, "text/plain; charset=utf-8", "The console answers requests addressed to localhost only.\n");
      return;
    }
    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
    if (pathname === "/api/snapshot") {
      serveSnapshot(res, options, refresher);
      return;
    }
    if (pathname === VERSION_ROUTE) {
      serveVersion(res, updates, builds);
      return;
    }
    if (req.method === "POST" && pathname.startsWith(ISSUE_PREFIX)) {
      const acting = actionRoute(pathname);
      if (acting === undefined) {
        sendJson(res, 404, {
          message: `No console action at ${pathname}. The actions are ${ACTIONS.join(", ")}.`,
        });
        return;
      }
      void serveAction(req, res, options, acting).catch((cause: unknown) => {
        sendActionFailure(res, acting, cause);
      });
      return;
    }
    if (pathname.startsWith(ISSUE_PREFIX)) {
      const route = issueRoute(pathname);
      if (route === undefined) {
        send(res, 404, "text/plain; charset=utf-8", `Not found: ${pathname}\n`);
        return;
      }
      void serveIssue(res, options, route).catch((cause: unknown) => {
        sendIssueFailure(res, pathname, route, cause);
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
