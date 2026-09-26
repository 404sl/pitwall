import type { FilterState, ReadyRow, SortKey } from "../model.js";
import { priorityLabel } from "../format.js";
import { issueHref } from "../routes.js";
import { strings } from "../strings.js";
import { WhoCells } from "./NeedsYou.js";

interface ReadyProps {
  rows: ReadyRow[];
  total: number;
  filter?: FilterState;
  sort?: SortKey;
  filteredEmpty?: string;
}

export function Ready({ rows, total, filter, sort, filteredEmpty }: ReadyProps) {
  if (rows.length === 0) {
    return <p className="pw-empty">{filteredEmpty ?? strings.empty.ready}</p>;
  }
  const rest = total - rows.length;
  return (
    <>
      <table className="pw-table pw-table--ready" role="table">
        <caption className="pw-sr">{strings.caption.ready}</caption>
        <thead className="pw-sr" role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">{strings.column.project}</th>
            <th scope="col" role="columnheader">{strings.column.issue}</th>
            <th scope="col" role="columnheader">{strings.column.priority}</th>
            <th scope="col" role="columnheader">{strings.column.owner}</th>
            <th scope="col" role="columnheader">{strings.column.reporter}</th>
            <th scope="col" role="columnheader">{strings.column.title}</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={row.id} className="pw-row" role="row">
              <th scope="row" className="pw-cell pw-cell--project" role="rowheader">
                {row.project}
              </th>
              <td className="pw-cell pw-cell--id" role="cell">{row.id}</td>
              <td className="pw-cell pw-cell--data" role="cell" title={row.priority === undefined ? strings.stale.noPriority : undefined}>
                {priorityLabel(row.priority)}
              </td>
              <WhoCells row={row} />
              <td className="pw-cell pw-cell--title" role="cell">
                <a className="pw-link" href={issueHref(row.projectId, row.id, filter, sort)}>
                  {row.title}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rest > 0 ? <p className="pw-more">{`+${rest} ${strings.ready.more}`}</p> : null}
    </>
  );
}
