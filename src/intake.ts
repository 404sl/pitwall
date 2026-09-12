export const INTAKE_ROUTE = "/api/intake";
export const INTAKE_DIR = ".pitwall-intake";
export const INTAKE_LABEL = "unrefined";
export const INTAKE_TYPE = "task";
export const PLANNING_SUFFIX = "-planning-session";

const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * KILOBYTE;

export const MAX_FILE_BYTES = 10 * MEGABYTE;
export const MAX_REQUEST_BYTES = 25 * MEGABYTE;
export const MAX_FILES = 10;
export const MAX_BODY_BYTES = MAX_REQUEST_BYTES + MEGABYTE;

export const TITLE_LIMIT = 120;
const ELLIPSIS = "…";
const NAME_LIMIT = 100;

export type RefusalKind = "size" | "count" | "total";

export interface Sized {
  name: string;
  bytes: number;
}

export type Refused<T extends Sized = Sized> = T & { kind: RefusalKind };

export interface Sifted<T extends Sized> {
  accepted: T[];
  refused: Refused<T>[];
}

export function planningSession(projectId: string): string {
  return `${projectId}${PLANNING_SUFFIX}`;
}

export function fileSize(bytes: number): string {
  if (bytes < KILOBYTE) {
    return `${String(bytes)} B`;
  }
  const kilobytes = Math.round(bytes / KILOBYTE);
  if (kilobytes < KILOBYTE) {
    return `${String(kilobytes)} KB`;
  }
  const scaled = (bytes / MEGABYTE).toFixed(1);
  return `${scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled} MB`;
}

export function sift<T extends Sized>(files: readonly T[]): Sifted<T> {
  const accepted: T[] = [];
  const refused: Refused<T>[] = [];
  let total = 0;
  for (const file of files) {
    if (file.bytes > MAX_FILE_BYTES) {
      refused.push({ ...file, kind: "size" });
    } else if (accepted.length >= MAX_FILES) {
      refused.push({ ...file, kind: "count" });
    } else if (total + file.bytes > MAX_REQUEST_BYTES) {
      refused.push({ ...file, kind: "total" });
    } else {
      accepted.push(file);
      total += file.bytes;
    }
  }
  return { accepted, refused };
}

function firstLine(raw: string): string | undefined {
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text !== "") {
      return text;
    }
  }
  return undefined;
}

export function titleOf(raw: string, names: readonly string[]): string {
  const line = firstLine(raw) ?? names[0] ?? "";
  return line.length <= TITLE_LIMIT ? line : line.slice(0, TITLE_LIMIT - 1) + ELLIPSIS;
}

export function safeName(name: string): string {
  const tail = name.split(/[/\\]/).at(-1) ?? "";
  const cleaned = tail.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const trimmed = cleaned.slice(0, NAME_LIMIT);
  return trimmed === "" ? "file" : trimmed;
}

function numbered(name: string, nth: number): string {
  const dot = name.lastIndexOf(".");
  const suffix = `-${String(nth)}`;
  return dot <= 0 ? `${name}${suffix}` : `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}

export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const safe = safeName(name);
    let candidate = safe;
    let nth = 2;
    while (taken.has(candidate)) {
      candidate = numbered(safe, nth);
      nth += 1;
    }
    taken.add(candidate);
    return candidate;
  });
}
