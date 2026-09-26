import { problemKey, type ProblemRow } from "../model.js";
import { clock, fill, stamp } from "../format.js";
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

function preventedText(count: number | undefined): string {
  if (count === undefined) {
    return "";
  }
  return count === 1
    ? ` ${strings.problems.prevented.one}`
    : ` ${fill(strings.problems.prevented.many, { count: String(count) })}`;
}

export function Problems({ rows }: { rows: ProblemRow[] }) {
  if (rows.length === 0) {
    return <p className="pw-empty">{strings.empty.problems}</p>;
  }
  return (
    <table className="pw-table pw-table--problems" role="table">
      <caption className="pw-sr">{strings.caption.problems}</caption>
      <thead className="pw-sr" role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">{strings.column.scope}</th>
          <th scope="col" role="columnheader">{strings.column.source}</th>
          <th scope="col" role="columnheader">{strings.column.message}</th>
          <th scope="col" role="columnheader">{strings.column.at}</th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row) => (
          <tr
            key={problemKey(row)}
            className="pw-row"
            role="row"
            aria-live={row.scope === "console" ? "polite" : undefined}
            aria-atomic={row.scope === "console" ? true : undefined}
          >
            <th scope="row" className="pw-cell pw-cell--project" role="rowheader">
              {scopeLabel(row)}
            </th>
            <td className="pw-cell pw-cell--source" role="cell">{row.source}</td>
            <td className="pw-cell pw-cell--title" role="cell">
              {row.message}
              {preventedText(row.prevented)}
            </td>
            <td className="pw-cell pw-cell--at" role="cell" title={stamp(row.at)}>
              {clock(row.at)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
