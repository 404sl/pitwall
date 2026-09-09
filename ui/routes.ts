import { FILTER_KEYS, type FilterState } from "../src/board.js";

export const BOARD_HASH = "#/";

const ISSUE_HASH = "#/issue/";

export interface IssueRoute {
  project: string;
  id: string;
}

export function filterQuery(filter: FilterState): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filter[key];
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function filterOf(hash: string): FilterState {
  const cut = hash.indexOf("?");
  if (cut === -1) {
    return {};
  }
  const params = new URLSearchParams(hash.slice(cut + 1));
  const filter: FilterState = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== "") {
      filter[key] = value;
    }
  }
  return filter;
}

export function boardHref(filter: FilterState): string {
  return `${BOARD_HASH}${filterQuery(filter)}`;
}

export function issueHref(project: string, id: string, filter: FilterState = {}): string {
  return `${ISSUE_HASH}${encodeURIComponent(project)}/${encodeURIComponent(id)}${filterQuery(filter)}`;
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
