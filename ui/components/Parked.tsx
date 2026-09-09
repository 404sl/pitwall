import { Fragment } from "react";
import { blockedSummary, parkedCounts, parkedSummary, type ParkedCount, type ParkedEntry } from "../model.js";
import { ofParts } from "../format.js";
import { strings } from "../strings.js";

function Count({ part }: { part: ParkedCount }) {
  const [lead, rest] = ofParts(part.count, part.total ?? part.count);
  return (
    <>
      {`${part.reason} ${lead}`}
      <span className="pw-of">{rest}</span>
    </>
  );
}

function Reasons({ parts }: { parts: ParkedCount[] }) {
  return (
    <p className="pw-parked">
      {parts.map((part, index) => (
        <Fragment key={part.reason}>
          {index === 0 ? null : strings.filters.separator}
          <Count part={part} />
        </Fragment>
      ))}
    </p>
  );
}

interface ParkedProps {
  entries: ParkedEntry[];
  totals?: ParkedEntry[];
  filteredEmpty?: string;
}

export function Parked({ entries, totals, filteredEmpty }: ParkedProps) {
  if (entries.length === 0) {
    return <p className="pw-empty">{filteredEmpty ?? strings.empty.parked}</p>;
  }
  if (totals === undefined) {
    const reasons = parkedSummary(entries);
    const blocked = blockedSummary(entries);
    return (
      <>
        {reasons === "" ? null : <p className="pw-parked">{reasons}</p>}
        {blocked === "" ? null : <p className="pw-parked pw-parked--blocked">{blocked}</p>}
      </>
    );
  }
  const parts = parkedCounts(entries, totals);
  const reasons = parts.filter((part) => part.reason !== "blocked");
  const blocked = parts.find((part) => part.reason === "blocked");
  return (
    <>
      {reasons.length === 0 ? null : <Reasons parts={reasons} />}
      {blocked === undefined ? null : (
        <p className="pw-parked pw-parked--blocked">
          <Count part={blocked} />
        </p>
      )}
    </>
  );
}
