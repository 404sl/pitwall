import { PARK_SUSPECT_DAYS, type ParkAge as ParkAgeValue } from "../model.js";
import { elapsed, fill, stamp } from "../format.js";
import { strings } from "../strings.js";

export function ParkAge({ park }: { park: ParkAgeValue }) {
  if (park.since === undefined || park.ms === undefined) {
    return (
      <span className="pw-age" title={strings.park.unknownTitle}>
        {strings.issue.facts.none}
      </span>
    );
  }
  const since = fill(strings.park.sinceTitle, { at: stamp(park.since) });
  if (!park.suspect) {
    return (
      <span className="pw-age" title={since}>
        {elapsed(park.ms)}
      </span>
    );
  }
  return (
    <>
      <span className="pw-age pw-age--suspect" title={`${since} ${fill(strings.park.suspectTitle, { days: PARK_SUSPECT_DAYS })}`}>
        {elapsed(park.ms)}
      </span>
      <span className="pw-age__flag">{strings.park.suspect}</span>
    </>
  );
}
