import type { CollectionError } from "@404sl/pitwall-schema";

export function collectionError(source: string, cause: unknown): CollectionError {
  return {
    source,
    message: cause instanceof Error ? cause.message : String(cause),
    at: new Date().toISOString(),
  };
}
