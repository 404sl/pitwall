import { Fragment, useState } from "react";
import { problemGroups, problemKey, type ProblemEntry, type ProblemRow } from "../model.js";
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

function Row({ row }: { row: ProblemRow }) {
  return (
    <tr className="pw-row" role={row.scope === "console" ? "status" : undefined}>
      <th scope="row" className="pw-cell pw-cell--project">
        {scopeLabel(row)}
      </th>
      <td className="pw-cell pw-cell--source">{row.source}</td>
      <td className="pw-cell pw-cell--title">{row.message}</td>
      <td className="pw-cell pw-cell--at" title={stamp(row.at)}>
        {clock(row.at)}
      </td>
    </tr>
  );
}

function groupScope(rows: ProblemRow[]): string {
  const named = [...new Set(rows.map((row) => scopeLabel(row)))];
  const [only] = named;
  return named.length === 1 && only !== undefined
    ? only
    : fill(strings.problems.group.acrossProjects, { count: String(named.length) });
}

interface GroupProps {
  entry: Extract<ProblemEntry, { kind: "group" }>;
  open: boolean;
  onToggle: () => void;
}

function Group({ entry, open, onToggle }: GroupProps) {
  const detail = `problems-${entry.key}`;
  return (
    <Fragment>
      <tbody>
        <tr className="pw-row">
          <th scope="row" className="pw-cell pw-cell--project">
            {groupScope(entry.rows)}
          </th>
          <td className="pw-cell pw-cell--source">{entry.source}</td>
          <td className="pw-cell pw-cell--title">
            {fill(strings.problems.group.affected, { count: String(entry.rows.length) })}
            <span aria-hidden="true" className="pw-disclosure__separator">
              {strings.filters.separator}
            </span>
            <span className="pw-problems__cause">{strings.problems.group.cause[entry.cause]}</span>
            <span aria-hidden="true" className="pw-disclosure__separator">
              {strings.filters.separator}
            </span>
            <button
              type="button"
              className="pw-problems__toggle"
              aria-expanded={open}
              aria-controls={detail}
              onClick={onToggle}
            >
              <span className="pw-disclosure__label">
                {open
                  ? strings.problems.group.hide
                  : fill(strings.problems.group.show, { count: String(entry.rows.length) })}
              </span>
            </button>
          </td>
          <td className="pw-cell pw-cell--at" title={stamp(entry.at)}>
            {clock(entry.at)}
          </td>
        </tr>
      </tbody>
      <tbody id={detail} className="pw-problems__detail" hidden={!open}>
        {entry.rows.map((row) => (
          <Row key={problemKey(row)} row={row} />
        ))}
      </tbody>
    </Fragment>
  );
}

export function Problems({ rows }: { rows: ProblemRow[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  if (rows.length === 0) {
    return <p className="pw-empty">{strings.empty.problems}</p>;
  }
  const toggle = (key: string) => {
    setOpen((held) => {
      const next = new Set(held);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  };
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
      {problemGroups(rows).map((entry) =>
        entry.kind === "group" ? (
          <Group key={entry.key} entry={entry} open={open.has(entry.key)} onToggle={() => toggle(entry.key)} />
        ) : (
          <tbody key={entry.key}>
            {entry.rows.map((row) => (
              <Row key={problemKey(row)} row={row} />
            ))}
          </tbody>
        ),
      )}
    </table>
  );
}
