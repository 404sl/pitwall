import type { CollectionError } from "@404sl/pitwall-schema";

export function collectionError(source: string, cause: unknown): CollectionError {
  return {
    source,
    message: cause instanceof Error ? cause.message : String(cause),
    at: new Date().toISOString(),
  };
}

export function failureOf(cause: unknown, timeoutMs: number): string {
  const failed = cause as { killed?: unknown; stderr?: unknown } | null;
  if (failed?.killed === true) {
    return `timed out after ${timeoutMs}ms`;
  }
  const stderr = failed?.stderr;
  const reported = typeof stderr === "string" ? stderr.trim() : "";
  if (reported !== "") {
    return reported.split("\n")[0] ?? reported;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function recordOnce(errors: CollectionError[], error: CollectionError): void {
  const known = errors.some(
    (other) => other.source === error.source && other.message === error.message,
  );
  if (!known) {
    errors.push(error);
  }
}
