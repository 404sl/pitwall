import type { FilterState, NeedsYouGroup, NeedsYouRow, SortKey } from "../model.js";
import { VERDICT_CLASS, VERDICT_WORD, clock, priorityLabel } from "../format.js";
import { issueHref } from "../routes.js";
import { strings } from "../strings.js";
import { ParkAge } from "./ParkAge.js";

export function Staleness({ row }: { row: { verdict: NeedsYouRow["verdict"]; checkedAt?: string } }) {
  const title = row.checkedAt === undefined ? undefined : `${strings.stale.checkedAt} ${clock(row.checkedAt)}`;
  return (
    <span className={`pw-stale ${VERDICT_CLASS[row.verdict]}`} title={title}>
      {VERDICT_WORD[row.verdict]}
    </span>
  );
}

export function Who({ value, absent }: { value: string | undefined; absent: string }) {
  if (value === undefined) {
    return (
      <td className="pw-cell pw-cell--who" role="cell">
        <span className="pw-absent">{absent}</span>
      </td>
    );
  }
  return (
    <td className="pw-cell pw-cell--data pw-cell--who" role="cell" title={value}>
      {value}
    </td>
  );
}

export function WhoCells({ row }: { row: { owner?: string; reporter?: string } }) {
  return (
    <>
      <Who value={row.owner} absent={strings.who.unassigned} />
      <Who value={row.reporter} absent={strings.who.unreported} />
    </>
  );
}

function Kind({ row }: { row: NeedsYouRow }) {
  if (row.misfiled) {
    return (
      <td className="pw-cell pw-cell--kind" role="cell" title={strings.park.misfiledTitle}>
        {strings.kind.misfiled}
      </td>
    );
  }
  return <td className="pw-cell pw-cell--kind" role="cell">{strings.kind[row.kind]}</td>;
}

interface NeedsYouProps {
  groups: NeedsYouGroup[];
  filter?: FilterState;
  sort?: SortKey;
  filteredEmpty?: string;
  caption?: string;
  empty?: string;
}

export function NeedsYou({
  groups,
  filter,
  sort,
  filteredEmpty,
  caption = strings.caption.needsYou,
  empty = strings.empty.needsYou,
}: NeedsYouProps) {
  if (groups.length === 0) {
    return <p className="pw-empty">{filteredEmpty ?? empty}</p>;
  }
  return (
    <table className="pw-table pw-table--needs" role="table">
      <caption className="pw-sr">{caption}</caption>
      <thead className="pw-sr" role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">{strings.column.issue}</th>
          <th scope="col" role="columnheader">{strings.column.priority}</th>
          <th scope="col" role="columnheader">{strings.column.owner}</th>
          <th scope="col" role="columnheader">{strings.column.reporter}</th>
          <th scope="col" role="columnheader">{strings.column.kind}</th>
          <th scope="col" role="columnheader">{strings.column.title}</th>
          <th scope="col" role="columnheader">{strings.column.parked}</th>
          <th scope="col" role="columnheader">{strings.column.staleness}</th>
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.project} role="rowgroup">
          <tr className="pw-group" role="row">
            <th colSpan={8} scope="rowgroup" role="rowheader">
              {group.project}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.id} className="pw-row" role="row">
              <td className="pw-cell pw-cell--id" role="cell">{row.id}</td>
              <td className="pw-cell pw-cell--data" role="cell" title={row.priority === undefined ? strings.stale.noPriority : undefined}>
                {priorityLabel(row.priority)}
              </td>
              <WhoCells row={row} />
              <Kind row={row} />
              <td className="pw-cell pw-cell--title" role="cell">
                <a className="pw-link" href={issueHref(group.projectId, row.id, filter, sort)}>
                  {row.title}
                </a>
              </td>
              <td className="pw-cell pw-cell--at" role="cell">
                <ParkAge park={row.park} />
              </td>
              <td className="pw-cell pw-cell--stale" role="cell">
                <Staleness row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
