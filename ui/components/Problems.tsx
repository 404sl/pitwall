import { problemKey, type ProblemRow } from "../model.js";
import { clock, stamp } from "../format.js";
import { strings } from "../strings.js";

function scopeLabel(row: ProblemRow): string {
  if (row.scope === "run") {
    return strings.problems.run;
  }
  if (row.scope === "console") {
    return strings.problems.console;
  }
  return row.name;
}

export function Problems({ rows }: { rows: ProblemRow[] }) {
  if (rows.length === 0) {
    return <p className="pw-empty">{strings.empty.problems}</p>;
  }
  return (
    <table className="pw-table pw-table--problems">
      <caption className="pw-sr">{strings.caption.problems}</caption>
      <thead className="pw-sr">
        <tr>
          <th scope="col">{strings.column.scope}</th>
          <th scope="col">{strings.column.source}</th>
          <th scope="col">{strings.column.message}</th>
          <th scope="col">{strings.column.at}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={problemKey(row)}
            className="pw-row"
            role={row.scope === "console" ? "status" : undefined}
          >
            <th scope="row" className="pw-cell pw-cell--project">
              {scopeLabel(row)}
            </th>
            <td className="pw-cell pw-cell--id">{row.source}</td>
            <td className="pw-cell pw-cell--title">{row.message}</td>
            <td className="pw-cell pw-cell--at" title={stamp(row.at)}>
              {clock(row.at)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
