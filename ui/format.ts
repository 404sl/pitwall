import type { StalenessVerdict } from "@404sl/pitwall-schema";
import { strings } from "./strings.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function elapsed(ms: number): string {
  if (ms < MINUTE) {
    return "<1m";
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)}m`;
  }
  if (ms < DAY) {
    return `${Math.floor(ms / HOUR)}h${Math.floor((ms % HOUR) / MINUTE)}m`;
  }
  return `${Math.floor(ms / DAY)}d${Math.floor((ms % DAY) / HOUR)}h`;
}

export function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(at);
}

export function priorityLabel(priority: number | undefined): string {
  return priority === undefined ? "—" : `P${priority}`;
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export const VERDICT_WORD: Record<StalenessVerdict, string> = {
  unchecked: strings.stale.unchecked,
  "still-blocking": strings.stale.stillBlocking,
  "likely-stale": strings.stale.likelyStale,
  resolved: strings.stale.resolved,
};

export const VERDICT_CLASS: Record<StalenessVerdict, string> = {
  unchecked: "pw-stale--unchecked",
  "still-blocking": "pw-stale--still-blocking",
  "likely-stale": "pw-stale--likely-stale",
  resolved: "pw-stale--resolved",
};
