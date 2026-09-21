import { FILTER_KEYS, SORT_PARAM, sortKeyOf, type FilterState, type SortKey } from "../src/board.js";

export const BOARD_HASH = "#/";

const ISSUE_HASH = "#/issue/";

export interface IssueRoute {
  project: string;
  id: string;
}

export function filterQuery(filter: FilterState, sort?: SortKey): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filter[key];
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  if (sort !== undefined) {
    params.set(SORT_PARAM, sort);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

function paramsOf(hash: string): URLSearchParams {
  const cut = hash.indexOf("?");
  return new URLSearchParams(cut === -1 ? "" : hash.slice(cut + 1));
}

export function filterOf(hash: string): FilterState {
  const params = paramsOf(hash);
  const filter: FilterState = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== "") {
      filter[key] = value;
    }
  }
  return filter;
}

export function sortOf(hash: string): SortKey | undefined {
  return sortKeyOf(paramsOf(hash).get(SORT_PARAM));
}

export function boardHref(filter: FilterState, sort?: SortKey): string {
  return `${BOARD_HASH}${filterQuery(filter, sort)}`;
}

export function issueHref(project: string, id: string, filter: FilterState = {}, sort?: SortKey): string {
  return `${ISSUE_HASH}${encodeURIComponent(project)}/${encodeURIComponent(id)}${filterQuery(filter, sort)}`;
}

export function routeOf(hash: string): IssueRoute | undefined {
  const cut = hash.indexOf("?");
  const path = cut === -1 ? hash : hash.slice(0, cut);
  if (!path.startsWith(ISSUE_HASH)) {
    return undefined;
  }
  const segments = path.slice(ISSUE_HASH.length).split("/");
  if (segments.length !== 2) {
    return undefined;
  }
  let project: string;
  let id: string;
  try {
    [project, id] = segments.map((segment) => decodeURIComponent(segment)) as [string, string];
  } catch {
    return undefined;
  }
  return project === "" || id === "" ? undefined : { project, id };
}
