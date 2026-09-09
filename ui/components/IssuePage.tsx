import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Authority, Classification, StalenessVerdict } from "@404sl/pitwall-schema";
import type { ClassificationReason } from "../../src/classify.js";
import {
  buildIssueView,
  type IssueLink,
  type IssuePayload,
  type IssuePreview,
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

function Reason({
  classification,
  reason,
  project,
}: {
  classification?: Classification;
  reason?: ClassificationReason;
  project: string;
}) {
  if (classification === undefined || reason?.rule === "closed") {
    return <p className="pw-reason">{strings.issue.notClassified}</p>;
  }
  return (
    <p className="pw-reason">
      <span className="pw-reason__token">{classification}</span>
      {reason === undefined ? null : (
        <span className="pw-reason__because">
          {strings.issue.because}
          <Interpolated
            template={strings.issue.reason[reason.rule]}
            values={reasonValues(reason, project)}
          />
        </span>
      )}
    </p>
  );
}

export function callFor(
  classification: Classification | undefined,
  verdict: StalenessVerdict,
  closed: boolean,
): { text: string; tone: "yours" | "waiting" } {
  if (closed || classification === undefined) {
    return { text: strings.issue.call.closed, tone: "waiting" };
  }
  const expired = verdict === "likely-stale" || verdict === "resolved";
  switch (classification) {
    case "yours:decision":
      return {
        text: expired ? strings.issue.call.decision.stale : strings.issue.call.decision.standing,
        tone: "yours",
      };
    case "yours:access":
      return {
        text: expired ? strings.issue.call.access.stale : strings.issue.call.access.standing,
        tone: "yours",
      };
    case "in-flight":
      return { text: strings.issue.call.inFlight, tone: "waiting" };
    case "landing":
      return { text: strings.issue.call.landing, tone: "waiting" };
    case "ready":
      return { text: strings.issue.call.ready, tone: "waiting" };
    case "blocked":
      return { text: strings.issue.call.blocked, tone: "waiting" };
    default:
      return {
        text: fill(strings.issue.call.parked, { reason: classification.slice("parked:".length) }),
        tone: "waiting",
      };
  }
}

function Call({ shown }: { shown: IssuePreview }) {
  const call = callFor(shown.classification, shown.staleness.verdict, shown.closed);
  return <p className={`pw-call pw-call--${call.tone}`}>{call.text}</p>;
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
      {staleness.evidence.length === 0 ? null : (
        <ul className="pw-evidence">
          {staleness.evidence.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      )}
      {staleness.checked && staleness.evidence.length === 0 ? (
        <p className="pw-empty">{strings.issue.stale.noEvidence}</p>
      ) : null}
      {staleness.unresolved === 0 ? null : (
        <p className="pw-empty pw-empty--method">
          {staleness.unresolved === 1
            ? strings.issue.stale.unresolvedOne
            : fill(strings.issue.stale.unresolved, { count: String(staleness.unresolved) })}
        </p>
      )}
      <p className="pw-empty pw-empty--method">{strings.issue.stale.method}</p>
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

function Facts({ shown, superseded }: { shown: IssuePreview; superseded?: { status: string; at: string } }) {
  const none = strings.issue.facts.none;
  return (
    <div className={superseded === undefined ? "pw-facts" : "pw-facts pw-facts--superseded"}>
      {superseded === undefined ? null : (
        <p className="pw-facts__note">
          {fill(strings.issue.supersededFields, {
            status: superseded.status,
            at: clock(superseded.at),
          })}
        </p>
      )}
      <dl className="pw-facts__list">
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.project}</dt>
        <dd className="pw-facts__value">{shown.projectName}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.status}</dt>
        <dd className="pw-facts__value pw-cell--data">{shown.status}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.priority}</dt>
        <dd className="pw-facts__value pw-cell--data">{priorityLabel(shown.priority)}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.type}</dt>
        <dd className="pw-facts__value pw-cell--data">{shown.issueType ?? none}</dd>
      </div>
      <div className="pw-facts__pair">
        <dt className="pw-facts__term">{strings.issue.facts.labels}</dt>
        <dd className="pw-facts__value">
          {shown.labels.length === 0 ? (
            <span className="pw-cell--data">{none}</span>
          ) : (
            <span className="pw-chips">
              {shown.labels.map((label) => (
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

function shownOf(view: IssueView): IssuePreview {
  const { issue } = view;
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    issueType: issue.issueType,
    priority: issue.priority,
    labels: issue.labels,
    project: issue.project,
    projectName: issue.projectName,
    classification: issue.classification,
    closed: view.closed,
    staleness: view.staleness,
  };
}

export function IssuePage({ route, preview }: { route: IssueRoute; preview?: IssuePreview }) {
  const [view, setView] = useState<IssueView | undefined>(undefined);
  const [failure, setFailure] = useState<PageFailure | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<string | undefined>(undefined);

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

  const shown = view === undefined ? preview : shownOf(view);
  const key = `${route.project}/${route.id}`;

  useEffect(() => {
    if (shown !== undefined && focused.current !== key && heading.current !== null) {
      heading.current.focus();
      focused.current = key;
    }
  });

  const back = (
    <a className="pw-link pw-link--back" href={BOARD_HASH}>
      {strings.issue.back}
    </a>
  );

  const failed = failure === undefined ? null : (
    <Failure heading={failure.heading} message={failure.message}>
      {failure.tried.length === 0 ? null : (
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
  );

  if (shown === undefined) {
    return (
      <>
        {back}
        {loading ? (
          <p className="pw-empty" role="status">
            {strings.issue.loading}
          </p>
        ) : (
          failed ?? <Failure message="" />
        )}
      </>
    );
  }

  return (
    <>
      <div className="pw-issue__head">
        {back}
        <h2 className="pw-issue__title" ref={heading} tabIndex={-1}>
          {shown.title}
        </h2>
        <Call shown={shown} />
        <p className="pw-issue__id">{shown.id}</p>
        {view?.closedSinceSnapshot === true && view.snapshot !== undefined ? (
          <p className="pw-notice" role="status">
            {fill(strings.issue.closedSince, { at: clock(view.snapshot.generatedAt) })}
          </p>
        ) : null}
        <Facts
          shown={shown}
          superseded={
            view?.closedSinceSnapshot === true && view.snapshot !== undefined
              ? { status: view.snapshot.status, at: view.readAt }
              : undefined
          }
        />
      </div>
      <Band
        id="classification"
        label={strings.issue.band.classification}
        level="h3"
        busy={view === undefined && failure === undefined}
      >
        <Reason
          classification={shown.classification}
          reason={view?.issue.reason}
          project={shown.project}
        />
      </Band>
      <Band id="staleness" label={strings.issue.band.staleness} level="h3">
        <Staleness staleness={shown.staleness} closed={shown.closed} />
      </Band>
      {failed ?? (
        <p className={view === undefined ? "pw-empty" : "pw-issue__vintage"} role="status">
          {view === undefined
            ? strings.issue.loading
            : fill(strings.issue.vintage, { at: clock(view.readAt) })}
        </p>
      )}
      {view === undefined ? null : (
        <>
          <Band id="description" label={strings.issue.band.description} level="h3">
            <Recorded
              authority={view.issue.authority}
              text={view.issue.description}
              empty={strings.issue.empty.description}
            />
          </Band>
          <Band id="notes" label={strings.issue.band.notes} level="h3">
            <Recorded
              authority={view.issue.authority}
              text={view.issue.notes}
              empty={strings.issue.empty.notes}
            />
          </Band>
          <Band id="dependencies" label={strings.issue.band.dependencies} level="h3">
            <Dependencies view={view} />
          </Band>
          <Origin view={view} />
        </>
      )}
    </>
  );
}
