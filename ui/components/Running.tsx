import { LANE_CHIP_LIMIT, type LaneChip, type RunningRow, type RunningState, type RunningTotal } from "../model.js";
import { elapsed } from "../format.js";
import { strings } from "../strings.js";

const STATE_WORD: Record<RunningState, string> = {
  working: strings.laneState.working,
  "awaiting-lander": strings.laneState.awaitingLander,
  stranded: strings.laneState.stranded,
};

const STATE_CLASS: Record<RunningState, string> = {
  working: "pw-row--signal",
  "awaiting-lander": "pw-row--hold",
  stranded: "pw-row--alert",
};

export function runningSummary(totals: RunningTotal[]): string {
  return totals.map((total) => `${total.count} ${STATE_WORD[total.state]}`).join(" \u00b7 ");
}

function chipLabel(chip: LaneChip): string {
  return chip.id ?? `${strings.lane.unassigned} ${chip.slot}`;
}

function Chips({ chips }: { chips: LaneChip[] }) {
  const shown = chips.slice(0, LANE_CHIP_LIMIT);
  const rest = chips.length - shown.length;
  return (
    <span className="pw-chips">
      {shown.map((chip) => (
        <span key={`${chip.slot}`} className="pw-chip">
          <span className="pw-chip__id">{chipLabel(chip)}</span>
          <span
            className="pw-chip__elapsed"
            title={chip.elapsedMs === undefined ? strings.lane.noActivity : undefined}
          >
            {chip.elapsedMs === undefined ? "—" : elapsed(chip.elapsedMs)}
          </span>
        </span>
      ))}
      {rest > 0 ? <span className="pw-chip pw-chip--rest">{`+${rest} ${strings.lane.more}`}</span> : null}
    </span>
  );
}

export function Running({ rows }: { rows: RunningRow[] }) {
  if (rows.length === 0) {
    return <p className="pw-empty">{strings.empty.running}</p>;
  }
  return (
    <table className="pw-table pw-table--running">
      <caption className="pw-sr">{strings.caption.running}</caption>
      <thead className="pw-sr">
        <tr>
          <th scope="col">{strings.column.project}</th>
          <th scope="col">{strings.column.state}</th>
          <th scope="col">{strings.column.lanes}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.project}-${row.state}`} className={`pw-row ${STATE_CLASS[row.state]}`}>
            <th scope="row" className="pw-cell pw-cell--project">
              {row.project}
            </th>
            <td className="pw-cell pw-cell--state">
              <span className="pw-count">{row.count}</span> {STATE_WORD[row.state]}
            </td>
            <td className="pw-cell pw-cell--chips">
              <Chips chips={row.chips} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
