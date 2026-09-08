import { parkedSummary, type ParkedEntry } from "../model.js";
import { strings } from "../strings.js";

export function Parked({ entries }: { entries: ParkedEntry[] }) {
  if (entries.length === 0) {
    return <p className="pw-empty">{strings.empty.parked}</p>;
  }
  return <p className="pw-parked">{parkedSummary(entries)}</p>;
}
