import type { FilterState, NeedsYouGroup, SortKey } from "../model.js";
import { strings } from "../strings.js";
import { NeedsYou } from "./NeedsYou.js";

interface CallsProps {
  groups: NeedsYouGroup[];
  filter?: FilterState;
  sort?: SortKey;
  filteredEmpty?: string;
}

export function Calls({ groups, filter, sort, filteredEmpty }: CallsProps) {
  return (
    <NeedsYou
      groups={groups}
      filter={filter}
      sort={sort}
      filteredEmpty={filteredEmpty}
      caption={strings.caption.calls}
      empty={strings.empty.calls}
    />
  );
}
