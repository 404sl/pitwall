import type { StalenessVerdict } from "@404sl/pitwall-schema";
import { fill } from "../src/format.js";
import { strings } from "./strings.js";

export * from "../src/format.js";

export function countLabel(shown: number, total: number, filtered: boolean): string {
  return filtered
    ? fill(strings.filters.countOf, { shown: String(shown), total: String(total) })
    : String(shown);
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
