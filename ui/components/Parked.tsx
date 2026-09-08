import { blockedSummary, parkedSummary, type ParkedEntry } from "../model.js";
import { strings } from "../strings.js";

export function Parked({ entries }: { entries: ParkedEntry[] }) {
  if (entries.length === 0) {
    return <p className="pw-empty">{strings.empty.parked}</p>;
  }
  const reasons = parkedSummary(entries);
  const blocked = blockedSummary(entries);
  return (
    <>
      {reasons === "" ? null : <p className="pw-parked">{reasons}</p>}
      {blocked === "" ? null : <p className="pw-parked pw-parked--blocked">{blocked}</p>}
    </>
  );
}
