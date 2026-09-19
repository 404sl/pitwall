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
      <table className="pw-table pw-table--ready">
        <caption className="pw-sr">{strings.caption.ready}</caption>
        <thead className="pw-sr">
          <tr>
            <th scope="col">{strings.column.project}</th>
            <th scope="col">{strings.column.issue}</th>
            <th scope="col">{strings.column.priority}</th>
            <th scope="col">{strings.column.owner}</th>
            <th scope="col">{strings.column.reporter}</th>
            <th scope="col">{strings.column.title}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="pw-row">
              <th scope="row" className="pw-cell pw-cell--project">
                {row.project}
              </th>
              <td className="pw-cell pw-cell--id">{row.id}</td>
              <td className="pw-cell pw-cell--data" title={row.priority === undefined ? strings.stale.noPriority : undefined}>
                {priorityLabel(row.priority)}
              </td>
              <WhoCells row={row} />
              <td className="pw-cell pw-cell--title">
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
