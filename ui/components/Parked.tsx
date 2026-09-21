import { Fragment } from "react";
import {
  PARK_SUSPECT_DAYS,
  blockedSummary,
  parkedCounts,
  parkedSummary,
  type FilterState,
  type ParkedCount,
  type ParkedEntry,
  type ParkedGroup,
  type ParkedRows as ParkedRowsValue,
  type SortKey,
} from "../model.js";
import { fill, ofParts, priorityLabel } from "../format.js";
import { issueHref } from "../routes.js";
import { strings } from "../strings.js";
import { Staleness, WhoCells } from "./NeedsYou.js";
import { ParkAge } from "./ParkAge.js";

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

function Summary({ entries, totals }: { entries: ParkedEntry[]; totals?: ParkedEntry[] }) {
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

export function ParkedRows({
  groups,
  filter,
  sort,
  caption,
}: {
  groups: ParkedGroup[];
  filter?: FilterState;
  sort?: SortKey;
  caption: string;
}) {
  return (
    <table className="pw-table pw-table--parked">
      <caption className="pw-sr">{caption}</caption>
      <thead className="pw-sr">
        <tr>
          <th scope="col">{strings.column.issue}</th>
          <th scope="col">{strings.column.priority}</th>
          <th scope="col">{strings.column.owner}</th>
          <th scope="col">{strings.column.reporter}</th>
          <th scope="col">{strings.column.kind}</th>
          <th scope="col">{strings.column.title}</th>
          <th scope="col">{strings.column.parked}</th>
          <th scope="col">{strings.column.staleness}</th>
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.projectId}>
          <tr className="pw-group">
            <th colSpan={8} scope="rowgroup">
              {group.project}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.id} className="pw-row">
              <td className="pw-cell pw-cell--id">{row.id}</td>
              <td className="pw-cell pw-cell--data" title={row.priority === undefined ? strings.stale.noPriority : undefined}>
                {priorityLabel(row.priority)}
              </td>
              <WhoCells row={row} />
              <td className="pw-cell pw-cell--kind">{strings.parkReason[row.reason]}</td>
              <td className="pw-cell pw-cell--title">
                <a className="pw-link" href={issueHref(group.projectId, row.id, filter, sort)}>
                  {row.title}
                </a>
              </td>
              <td className="pw-cell pw-cell--at">
                <ParkAge park={row.park} />
              </td>
              <td className="pw-cell pw-cell--stale">
                <Staleness row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

interface ParkedProps {
  entries: ParkedEntry[];
  totals?: ParkedEntry[];
  rows?: ParkedRowsValue;
  filter?: FilterState;
  sort?: SortKey;
  filteredEmpty?: string;
}

export function Parked({ entries, totals, rows, filter, sort, filteredEmpty }: ParkedProps) {
  if (entries.length === 0) {
    return <p className="pw-empty">{filteredEmpty ?? strings.empty.parked}</p>;
  }
  return (
    <>
      <Summary entries={entries} totals={totals} />
      {rows === undefined || rows.suspect.length === 0 ? null : (
        <ParkedRows groups={rows.suspect} filter={filter} sort={sort} caption={strings.caption.parkedSuspect} />
      )}
      {rows === undefined || rows.rest.length === 0 ? null : (
        <details className="pw-disclosure">
          <summary className="pw-disclosure__summary">
            <span className="pw-disclosure__label">
              {fill(strings.park.restLabel, { days: PARK_SUSPECT_DAYS })}
            </span>
            <span aria-hidden="true" className="pw-disclosure__separator">
              {strings.issue.notes.separator}
            </span>
            <span className="pw-disclosure__hint">{strings.park.restHint}</span>
          </summary>
          <ParkedRows groups={rows.rest} filter={filter} sort={sort} caption={strings.caption.parkedRest} />
        </details>
      )}
    </>
  );
}
