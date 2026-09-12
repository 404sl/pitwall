import type { StalenessVerdict } from "@404sl/pitwall-schema";
import { fill } from "../src/format.js";
import { strings } from "./strings.js";

export * from "../src/format.js";

export const SHA_LENGTH = 7;

export function shortSha(commit: string): string {
  return commit.slice(0, SHA_LENGTH);
}

export function ofTotal(shown: number, total: number): string {
  return fill(strings.filters.countOf, { shown: String(shown), total: String(total) });
}

export function ofParts(shown: number, total: number): [string, string] {
  const lead = String(shown);
  const whole = ofTotal(shown, total);
  return [lead, whole.slice(whole.indexOf(lead) + lead.length)];
}

export function countLabel(shown: number, total: number, filtered: boolean): string {
  return filtered ? ofTotal(shown, total) : String(shown);
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
