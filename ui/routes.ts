export const BOARD_HASH = "#/";

const ISSUE_HASH = "#/issue/";

export interface IssueRoute {
  project: string;
  id: string;
}

export function issueHref(project: string, id: string): string {
  return `${ISSUE_HASH}${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

export function routeOf(hash: string): IssueRoute | undefined {
  if (!hash.startsWith(ISSUE_HASH)) {
    return undefined;
  }
  const segments = hash.slice(ISSUE_HASH.length).split("/");
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
