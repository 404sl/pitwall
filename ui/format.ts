import type { StalenessVerdict } from "@404sl/pitwall-schema";
import { strings } from "./strings.js";

export * from "../src/format.js";

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
