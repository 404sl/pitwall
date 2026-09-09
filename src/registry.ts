import { VERSION } from "./version.js";

export const REGISTRY_URL = "https://registry.npmjs.org/@404sl/pitwall/latest";
export const CHECK_EVERY_MS = 3_600_000;
export const CHECK_TIMEOUT_MS = 10_000;

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

export interface UpdateCheck {
  update: () => string | undefined;
  refresh: () => Promise<void>;
}

export interface UpdateCheckOptions {
  running?: string;
  url?: string;
  everyMs?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function parts(version: string): [number, number, number] | undefined {
  const found = RELEASE.exec(version);
  if (found === null) {
    return undefined;
  }
  const [, major, minor, patch] = found;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return [Number(major), Number(minor), Number(patch)];
}

export function newerThan(candidate: string, known: string): boolean {
  const found = parts(candidate);
  const held = parts(known);
  if (found === undefined || held === undefined) {
    return false;
  }
  for (let i = 0; i < found.length; i += 1) {
    const a = found[i] as number;
    const b = held[i] as number;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
}

export function createUpdateCheck(options: UpdateCheckOptions = {}): UpdateCheck {
  const running = options.running ?? VERSION;
  const url = options.url ?? REGISTRY_URL;
  const everyMs = options.everyMs ?? CHECK_EVERY_MS;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const get = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let published: string | undefined;
  let attemptedAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const read = async (): Promise<void> => {
    try {
      const response = await get(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return;
      }
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) {
        return;
      }
      const { version } = body as { version?: unknown };
      if (typeof version === "string" && newerThan(version, published ?? running)) {
        published = version;
      }
    } catch {
      return;
    }
  };

  const refresh = (): Promise<void> => {
    if (inFlight !== undefined) {
      return inFlight;
    }
    const at = now();
    if (attemptedAt !== undefined && at - attemptedAt < everyMs) {
      return Promise.resolve();
    }
    attemptedAt = at;
    const attempt = read().finally(() => {
      inFlight = undefined;
    });
    inFlight = attempt;
    return attempt;
  };

  return {
    update: () => {
      void refresh();
      return published;
    },
    refresh,
  };
}
