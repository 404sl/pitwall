import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Authority } from "@404sl/pitwall-schema";
import type { ClassificationReason } from "../../src/classify.js";
import {
  buildIssueView,
  type IssueLink,
  type IssuePayload,
  type IssueView,
  type StalenessView,
} from "../model.js";
import { VERDICT_CLASS, VERDICT_WORD, clock, fill, priorityLabel, stamp } from "../format.js";
import { BOARD_HASH, issueHref, type IssueRoute } from "../routes.js";
import { strings } from "../strings.js";
import { Band } from "./Band.js";
import { Failure } from "./Failure.js";

interface PageFailure {
  heading: string;
  message: string;
  tried: string[];
}

function issueUrl(route: IssueRoute): string {
  return `/api/issue/${encodeURIComponent(route.project)}/${encodeURIComponent(route.id)}`;
}

function textFrom(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function listFrom(body: unknown, key: string): string[] {
  if (typeof body !== "object" || body === null) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function failureFrom(route: IssueRoute, status: number, body: unknown, raw: string): PageFailure {
  if (status === 404) {
    return {
      heading: fill(strings.issue.failure.missing, {
        project: textFrom(body, "project") ?? route.project,
        id: textFrom(body, "id") ?? route.id,
      }),
      message: textFrom(body, "message") ?? raw,
      tried: [],
    };
  }
  return {
    heading: fill(strings.issue.failure.unreadable, { id: route.id }),
    message: textFrom(body, "message") ?? raw,
    tried: listFrom(body, "tried"),
  };
}

function Interpolated({ template, values }: { template: string; values: Record<string, ReactNode> }) {
  return (
    <>
      {template.split(/(\{\w+\})/).map((part, index) => {
        const key = /^\{(\w+)\}$/.exec(part)?.[1];
        const value = key === undefined ? undefined : values[key];
        return <Fragment key={index}>{value ?? part}</Fragment>;
      })}
    </>
  );
}

function IdLink({ project, id }: { project: string; id: string }) {
  return (
    <a className="pw-link" href={issueHref(project, id)}>
      {id}
    </a>
  );
}

function IdList({ project, ids }: { project: string; ids: string[] }) {
  return (
    <>
      {ids.map((id, index) => (
        <Fragment key={id}>
          {index === 0 ? null : strings.issue.reason.separator}
          <IdLink project={project} id={id} />
        </Fragment>
      ))}
    </>
  );
}

function reasonValues(reason: ClassificationReason, project: string): Record<string, ReactNode> {
  switch (reason.rule) {
    case "in-progress-lane":
      return { slot: String(reason.slot) };
    case "label":
      return { label: reason.label };
    case "umbrella-type":
      return { issueType: reason.issueType };
    case "umbrella-open-child":
      return { childId: <IdLink project={project} id={reason.childId} /> };
    case "blocked-open":
    case "blocked-unreadable":
      return { ids: <IdList project={project} ids={reason.ids} /> };
    case "blocked-parent-in-progress":
      return { parentId: <IdLink project={project} id={reason.parentId} /> };
    case "stored-status":
      return { status: reason.status };
    default:
      return {};
  }
}

function Reason({ view }: { view: IssueView }) {
  const { classification, reason, project } = view.issue;
  if (reason.rule === "closed" || classification === undefined) {
    return <p className="pw-reason">{strings.issue.notClassified}</p>;
  }
  return (
    <p className="pw-reason">
      <span className="pw-reason__token">{classification}</span>
      <span className="pw-reason__because">
        {strings.issue.because}
        <Interpolated
          template={strings.issue.reason[reason.rule]}
          values={reasonValues(reason, project)}
        />
      </span>
    </p>
  );
}

function Staleness({ staleness, closed }: { staleness: StalenessView; closed: boolean }) {
  if (closed && !staleness.checked) {
    return <p className="pw-empty">{strings.issue.stale.closed}</p>;
  }
  return (
    <>
      <p className="pw-reason">
        <span className={`pw-stale ${VERDICT_CLASS[staleness.verdict]}`}>
          {VERDICT_WORD[staleness.verdict]}
        </span>
        {staleness.checked && staleness.checkedAt !== undefined ? (
          <span className="pw-reason__because">{`${strings.stale.checkedAt} ${stamp(staleness.checkedAt)}`}</span>
        ) : null}
      </p>
      {closed && staleness.checked ? (
        <p className="pw-empty">{strings.issue.stale.closedCheck}</p>
      ) : null}
      {staleness.checked ? null : <p className="pw-empty">{strings.issue.stale.neverChecked}</p>}
      {staleness.checked && staleness.evidence.length === 0 ? (
        <p className="pw-empty">{strings.issue.stale.noEvidence}</p>
      ) : null}
      {staleness.evidence.length === 0 ? null : (
        <ul className="pw-evidence">
          {staleness.evidence.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Recorded({ authority, text, empty }: { authority: Authority; text?: string; empty: string }) {
  if (text === undefined) {
    return <p className="pw-empty">{empty}</p>;
  }
  const source =
    authority.location === undefined
      ? authority.kind
      : fill(strings.issue.recorded.at, { kind: authority.kind, location: authority.location });
  return (
    <figure className="pw-recorded">
      <figcaption className="pw-recorded__source">
        {fill(strings.issue.recorded.source, { source })}
      </figcaption>
      <pre className="pw-recorded__text">{text}</pre>
    </figure>
  );
}

function DependencyRows({ project, links }: { project: string; links: IssueLink[] }) {
  return (
    <>
      {links.map((link) => (
        <tr key={link.id} className="pw-row">
          <td className="pw-cell pw-cell--id">
            <IdLink project={project} id={link.id} />
          </td>
          <td className="pw-cell pw-cell--title">{link.title}</td>
          <td className="pw-cell pw-cell--data">{link.status}</td>
        </tr>
      ))}
    </>
  );
}

function Dependencies({ view }: { view: IssueView }) {
  const { project, blockedBy, blocks } = view.issue;
  return (
    <table className="pw-table pw-table--deps">
      <caption className="pw-sr">{strings.issue.band.dependencies}</caption>
      <thead className="pw-sr">
        <tr>
          <th scope="col">{strings.column.issue}</th>
          <th scope="col">{strings.column.title}</th>
          <th scope="col">{strings.column.state}</th>
        </tr>
      </thead>
      <tbody>
        <tr className="pw-group">
          <th colSpan={3} scope="rowgroup">
            {strings.issue.deps.dependsOn}
          </th>
        </tr>
        {blockedBy.length === 0 ? (
          <tr className="pw-row">
            <td className="pw-cell pw-empty" colSpan={3}>
              {strings.issue.deps.emptyOn}
            </td>
          </tr>
        ) : (
          <DependencyRows project={project} links={blockedBy} />
        )}
      </tbody>
      <tbody>
        <tr className="pw-group">
          <th colSpan={3} scope="rowgroup">
            {strings.issue.deps.dependedOnBy}
          </th>
        </tr>
        {blocks.length === 0 ? (
          <tr className="pw-row">
            <td className="pw-cell pw-empty" colSpan={3}>
              {strings.issue.deps.emptyBy}
            </td>
          </tr>
        ) : (
          <DependencyRows project={project} links={blocks} />
        )}
      </tbody>
    </table>
  );
}

function Facts({ view }: { view: IssueView }) {
  const { issue, closedSinceSnapshot, snapshot } = view;
  const none = strings.issue.facts.none;
  return (
    <div className={closedSinceSnapshot ? "pw-facts pw-facts--superseded" : "pw-facts"}>
      {closedSinceSnapshot && snapshot !== undefined ? (
        <p className="pw-facts__note">
          {fill(strings.issue.supersededFields, {
            status: snapshot.status,
            at: clock(view.readAt),
          })}
        </p>
      ) : null}
      <dl className="pw-facts__list">
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.project}</dt>
        <dd className="pw-facts__value">{issue.projectName}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.status}</dt>
        <dd className="pw-facts__value pw-cell--data">{issue.status}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.priority}</dt>
        <dd className="pw-facts__value pw-cell--data">{priorityLabel(issue.priority)}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.type}</dt>
        <dd className="pw-facts__value pw-cell--data">{issue.issueType ?? none}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.labels}</dt>
        <dd className="pw-facts__value">
          {issue.labels.length === 0 ? (
            <span className="pw-cell--data">{none}</span>
          ) : (
            <span className="pw-chips">
              {issue.labels.map((label) => (
                <span key={label} className="pw-chip">
                  {label}
                </span>
              ))}
            </span>
          )}
        </dd>
      </div>
      </dl>
    </div>
  );
}

function Origin({ view }: { view: IssueView }) {
  const origin = view.issue.origin;
  if (origin === undefined) {
    return null;
  }
  return (
    <Band id="origin" label={strings.issue.band.origin} level="h3">
      <dl className="pw-facts pw-facts__list">
        <div className="pw-facts__pair">
          <dt className="pw-facts__term">{strings.issue.origin.ref}</dt>
          <dd className="pw-facts__value pw-cell--data">{origin.ref}</dd>
        </div>
        <div className="pw-facts__pair">
          <dt className="pw-facts__term">{strings.issue.origin.session}</dt>
          <dd className="pw-facts__value pw-cell--data">{origin.session}</dd>
        </div>
      </dl>
    </Band>
  );
}

export function IssuePage({ route }: { route: IssueRoute }) {
  const [view, setView] = useState<IssueView | undefined>(undefined);
  const [failure, setFailure] = useState<PageFailure | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setView(undefined);
      setFailure(undefined);
      setLoading(true);
      let response: Response;
      try {
        response = await fetch(issueUrl(route), { signal, headers: { accept: "application/json" } });
      } catch (cause) {
        if (signal.aborted) {
          return;
        }
        setFailure({
          heading: fill(strings.issue.failure.unreadable, { id: route.id }),
          message: `${strings.failure.unreachable} ${window.location.origin}.`,
          tried: [issueUrl(route)],
        });
        setLoading(false);
        return;
      }
      const raw = await response.text();
      if (signal.aborted) {
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      if (response.ok) {
        setView(buildIssueView(body as IssuePayload));
      } else {
        setFailure(failureFrom(route, response.status, body, raw.trim()));
      }
      setLoading(false);
    },
    [route],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    document.title = `${route.id} · ${strings.brand}`;
    return () => {
      document.title = strings.brand;
    };
  }, [route.id]);

  useEffect(() => {
    if (view !== undefined) {
      heading.current?.focus();
    }
  }, [view]);

  const back = (
    <a className="pw-link pw-link--back" href={BOARD_HASH}>
      {strings.issue.back}
    </a>
  );

  if (view === undefined) {
    return (
      <>
        {back}
        {loading ? (
          <p className="pw-empty" role="status">
            {strings.issue.loading}
          </p>
        ) : (
          <Failure heading={failure?.heading} message={failure?.message ?? ""}>
            {failure === undefined || failure.tried.length === 0 ? null : (
              <>
                <p className="pw-recorded__source">{strings.issue.failure.tried}</p>
                <ul className="pw-evidence">
                  {failure.tried.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </>
            )}
          </Failure>
        )}
      </>
    );
  }

  const { issue } = view;
  return (
    <>
      <div className="pw-issue__head">
        {back}
        <h2 className="pw-issue__title" ref={heading} tabIndex={-1}>
          {issue.title}
        </h2>
        <p className="pw-issue__id">{issue.id}</p>
        {view.closedSinceSnapshot && view.snapshot !== undefined ? (
          <p className="pw-notice" role="status">
            {fill(strings.issue.closedSince, { at: clock(view.snapshot.generatedAt) })}
          </p>
        ) : null}
        <Facts view={view} />
      </div>
      <Band id="classification" label={strings.issue.band.classification} level="h3">
        <Reason view={view} />
        <p className="pw-issue__vintage">{fill(strings.issue.vintage, { at: clock(view.readAt) })}</p>
      </Band>
      <Band id="staleness" label={strings.issue.band.staleness} level="h3">
        <Staleness staleness={view.staleness} closed={view.closed} />
      </Band>
      <Band id="description" label={strings.issue.band.description} level="h3">
        <Recorded
          authority={issue.authority}
          text={issue.description}
          empty={strings.issue.empty.description}
        />
      </Band>
      <Band id="notes" label={strings.issue.band.notes} level="h3">
        <Recorded authority={issue.authority} text={issue.notes} empty={strings.issue.empty.notes} />
      </Band>
      <Band id="dependencies" label={strings.issue.band.dependencies} level="h3">
        <Dependencies view={view} />
      </Band>
      <Origin view={view} />
    </>
  );
}
