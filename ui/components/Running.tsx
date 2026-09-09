import {
  LANE_CHIP_LIMIT,
  type FilterState,
  type LaneChip,
  type RunningRow,
  type RunningState,
  type RunningTotal,
} from "../model.js";
import { elapsed, ofParts } from "../format.js";
import { issueHref } from "../routes.js";
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

export function runningSummary(totals: RunningTotal[], unfiltered?: RunningTotal[]): string {
  if (unfiltered === undefined) {
    return totals.map((total) => `${total.count} ${STATE_WORD[total.state]}`).join(" \u00b7 ");
  }
  const shown = new Map(totals.map((total) => [total.state, total.count]));
  return unfiltered
    .map((total) => {
      const [lead, rest] = ofParts(shown.get(total.state) ?? 0, total.count);
      return `${lead}${rest} ${STATE_WORD[total.state]}`;
    })
    .join(" \u00b7 ");
}

function Count({ count, total }: { count: number; total?: number }) {
  if (total === undefined) {
    return <span className="pw-count">{count}</span>;
  }
  const [lead, rest] = ofParts(count, total);
  return (
    <>
      <span className="pw-count">{lead}</span>
      <span className="pw-of">{rest}</span>
    </>
  );
}

function chipLabel(chip: LaneChip): string {
  return chip.id ?? `${strings.lane.unassigned} ${chip.slot}`;
}

function ChipId({ chip, projectId, filter }: { chip: LaneChip; projectId: string; filter?: FilterState }) {
  if (chip.id === undefined) {
    return <span className="pw-chip__id">{chipLabel(chip)}</span>;
  }
  return (
    <a className="pw-chip__id pw-link pw-link--chip" href={issueHref(projectId, chip.id, filter)}>
      {chip.id}
    </a>
  );
}

function Chips({ chips, projectId, filter }: { chips: LaneChip[]; projectId: string; filter?: FilterState }) {
  const shown = chips.slice(0, LANE_CHIP_LIMIT);
  const rest = chips.length - shown.length;
  return (
    <span className="pw-chips">
      {shown.map((chip) => (
        <span key={`${chip.slot}`} className="pw-chip">
          <ChipId chip={chip} projectId={projectId} filter={filter} />
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

interface RunningProps {
  rows: RunningRow[];
  filter?: FilterState;
  filteredEmpty?: string;
}

export function Running({ rows, filter, filteredEmpty }: RunningProps) {
  if (rows.length === 0) {
    return <p className="pw-empty">{filteredEmpty ?? strings.empty.running}</p>;
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
              <Count count={row.count} total={row.total} /> {STATE_WORD[row.state]}
            </td>
            <td className="pw-cell pw-cell--chips">
              <Chips chips={row.chips} projectId={row.projectId} filter={filter} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
