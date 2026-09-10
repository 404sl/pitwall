import type { TodayTotals } from "../model.js";
import { fill } from "../format.js";
import { strings } from "../strings.js";

const PLACEHOLDER = "{count}";

function Landed({ count }: { count: number | undefined }) {
  if (count !== undefined) {
    return <>{fill(strings.today.landed, { count: String(count) })}</>;
  }
  const [before, after] = strings.today.landed.split(PLACEHOLDER);
  return (
    <>
      {before ?? ""}
      <span className="pw-today__unknown">{strings.today.unknown}</span>
      <span className="pw-sr">{strings.today.unknownNotice}</span>
      {after ?? ""}
    </>
  );
}

export function Today({ today }: { today: TodayTotals }) {
  return (
    <p className="pw-today">
      <Landed count={today.landed} />
      {strings.filters.separator}
      {fill(strings.today.closed, { count: String(today.closed) })}
    </p>
  );
}
