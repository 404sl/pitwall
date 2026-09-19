import type { FilterState, NeedsYouGroup } from "../model.js";
import { strings } from "../strings.js";
import { NeedsYou } from "./NeedsYou.js";

interface CallsProps {
  groups: NeedsYouGroup[];
  filter?: FilterState;
  filteredEmpty?: string;
}

export function Calls({ groups, filter, filteredEmpty }: CallsProps) {
  return (
    <NeedsYou
      groups={groups}
      filter={filter}
      filteredEmpty={filteredEmpty}
      caption={strings.caption.calls}
      empty={strings.empty.calls}
    />
  );
}
