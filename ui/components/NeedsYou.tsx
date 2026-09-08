import type { NeedsYouGroup, NeedsYouRow } from "../model.js";
import { clock, priorityLabel } from "../format.js";
import { strings } from "../strings.js";

const VERDICT_WORD = {
  unchecked: strings.stale.unchecked,
  "still-blocking": strings.stale.stillBlocking,
  "likely-stale": strings.stale.likelyStale,
  resolved: strings.stale.resolved,
};

const VERDICT_CLASS = {
  unchecked: "pw-stale--unchecked",
  "still-blocking": "pw-stale--still-blocking",
  "likely-stale": "pw-stale--likely-stale",
  resolved: "pw-stale--resolved",
};

function Staleness({ row }: { row: NeedsYouRow }) {
  const title = row.checkedAt === undefined ? undefined : `${strings.stale.checkedAt} ${clock(row.checkedAt)}`;
  return (
    <span className={`pw-stale ${VERDICT_CLASS[row.verdict]}`} title={title}>
      {VERDICT_WORD[row.verdict]}
    </span>
  );
}

export function NeedsYou({ groups }: { groups: NeedsYouGroup[] }) {
  if (groups.length === 0) {
    return <p className="pw-empty">{strings.empty.needsYou}</p>;
  }
  return (
    <table className="pw-table pw-table--needs">
      <caption className="pw-sr">{strings.caption.needsYou}</caption>
      <thead className="pw-sr">
        <tr>
          <th scope="col">{strings.column.issue}</th>
          <th scope="col">{strings.column.priority}</th>
          <th scope="col">{strings.column.kind}</th>
          <th scope="col">{strings.column.title}</th>
          <th scope="col">{strings.column.staleness}</th>
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.project}>
          <tr className="pw-group">
            <th colSpan={5} scope="rowgroup">
              {group.project}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.id} className="pw-row">
              <td className="pw-cell pw-cell--id">{row.id}</td>
              <td className="pw-cell pw-cell--data" title={row.priority === undefined ? strings.stale.noPriority : undefined}>
                {priorityLabel(row.priority)}
              </td>
              <td className="pw-cell pw-cell--kind">{strings.kind[row.kind]}</td>
              <td className="pw-cell pw-cell--title">{row.title}</td>
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
