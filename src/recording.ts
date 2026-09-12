import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { issueActor, issueCreator, type ReadIssuesOptions } from "./beads.js";
import { INTAKE_DIR, INTAKE_LABEL, INTAKE_TYPE, planningSession, titleOf, uniqueNames } from "./intake.js";

export interface DroppedFile {
  name: string;
  body: Buffer;
}

export interface Request {
  raw: string;
  files: readonly DroppedFile[];
}

export interface RecordedProject {
  id: string;
  root: string;
}

export type Recording =
  | { kind: "recorded"; id: string; files: string[] }
  | { kind: "partial"; id: string; files: string[]; reason: string }
  | { kind: "unrecorded"; reason: string };

export type RecordOptions = Omit<ReadIssuesOptions, "errors">;

export function intakePath(root: string, id: string): string {
  return join(resolve(root), INTAKE_DIR, id);
}

export function filesNote(paths: readonly string[]): string {
  return paths.length === 1
    ? `One file was dropped with this request: ${paths[0] ?? ""}`
    : `${String(paths.length)} files were dropped with this request:\n${paths.join("\n")}`;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function writeDropped(root: string, id: string, files: readonly DroppedFile[]): string[] {
  const home = join(resolve(root), INTAKE_DIR);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitignore"), "*\n");
  const dir = intakePath(root, id);
  mkdirSync(dir, { recursive: true });
  const names = uniqueNames(files.map((file) => file.name));
  return names.map((name, index) => {
    writeFileSync(join(dir, name), files[index]?.body ?? Buffer.alloc(0));
    return `${INTAKE_DIR}/${id}/${name}`;
  });
}

export async function recordRequest(
  project: RecordedProject,
  request: Request,
  options: RecordOptions = {},
): Promise<Recording> {
  const assignee = planningSession(project.id);
  const room = mkdtempSync(join(tmpdir(), "pitwall-intake-"));
  const bodyFile = join(room, "request.txt");
  const metadataFile = join(room, "metadata.json");
  try {
    writeFileSync(bodyFile, request.raw, "utf8");
    writeFileSync(metadataFile, JSON.stringify({ intake: { raw: request.raw } }), "utf8");
    let id: string;
    try {
      id = await issueCreator(project.root, options)({
        title: titleOf(
          request.raw,
          request.files.map((file) => file.name),
        ),
        bodyFile,
        metadataFile,
        assignee,
        labels: [INTAKE_LABEL],
        issueType: INTAKE_TYPE,
      });
    } catch (cause) {
      return { kind: "unrecorded", reason: reasonOf(cause) };
    }
    if (request.files.length === 0) {
      return { kind: "recorded", id, files: [] };
    }
    let paths: string[];
    try {
      paths = writeDropped(project.root, id, request.files);
    } catch (cause) {
      return { kind: "partial", id, files: [], reason: reasonOf(cause) };
    }
    try {
      writeFileSync(
        metadataFile,
        JSON.stringify({ intake: { raw: request.raw, files: paths } }),
        "utf8",
      );
      await issueActor(project.root, options)(id, { metadataFile, note: filesNote(paths) });
    } catch (cause) {
      return { kind: "partial", id, files: paths, reason: reasonOf(cause) };
    }
    return { kind: "recorded", id, files: paths };
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
}
