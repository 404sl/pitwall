import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { isYours, type Authority, type Classification, type StalenessVerdict } from "@404sl/pitwall-schema";
import type { ClassificationReason } from "../../src/classify.js";
import { noteBlocks, noteSaid, quote } from "../../src/staleness.js";
import {
  buildIssueView,
  type FilterState,
  type IssueLink,
  type IssuePayload,
  type IssuePreview,
  type IssueView,
  type StalenessView,
} from "../model.js";
import { VERDICT_CLASS, VERDICT_WORD, clock, fill, priorityLabel, stamp } from "../format.js";
import { boardHref, issueHref, type IssueRoute } from "../routes.js";
import { strings } from "../strings.js";
import { Band } from "./Band.js";
import { Failure } from "./Failure.js";
import { IssueActions, type ActionName, type ActionOutcome } from "./IssueActions.js";

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

function IdLink({ project, id, filter }: { project: string; id: string; filter: FilterState }) {
  return (
    <a className="pw-link" href={issueHref(project, id, filter)}>
      {id}
    </a>
  );
}

function IdList({ project, ids, filter }: { project: string; ids: string[]; filter: FilterState }) {
  return (
    <>
      {ids.map((id, index) => (
        <Fragment key={id}>
          {index === 0 ? null : strings.issue.reason.separator}
          <IdLink project={project} id={id} filter={filter} />
        </Fragment>
      ))}
    </>
  );
}

function reasonValues(
  reason: ClassificationReason,
  project: string,
  filter: FilterState,
): Record<string, ReactNode> {
  switch (reason.rule) {
    case "in-progress-lane":
      return { slot: String(reason.slot) };
    case "label":
      return { label: reason.label };
    case "umbrella-type":
      return { issueType: reason.issueType };
    case "umbrella-open-child":
      return { childId: <IdLink project={project} id={reason.childId} filter={filter} /> };
    case "blocked-open":
    case "blocked-unreadable":
      return { ids: <IdList project={project} ids={reason.ids} filter={filter} /> };
    case "blocked-parent-in-progress":
      return { parentId: <IdLink project={project} id={reason.parentId} filter={filter} /> };
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
  filter,
}: {
  classification?: Classification;
  reason?: ClassificationReason;
  project: string;
  filter: FilterState;
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
            template={reasonTemplate(reason)}
            values={reasonValues(reason, project, filter)}
          />
        </span>
      )}
    </p>
  );
}

export function reasonTemplate(reason: Exclude<ClassificationReason, { rule: "closed" }>): string {
  switch (reason.rule) {
    case "blocked-open":
      return reason.ids.length === 1
        ? strings.issue.reason["blocked-open-one"]
        : strings.issue.reason["blocked-open-many"];
    case "blocked-unreadable":
      return reason.ids.length === 1
        ? strings.issue.reason["blocked-unreadable-one"]
        : strings.issue.reason["blocked-unreadable-many"];
    default:
      return strings.issue.reason[reason.rule];
  }
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
      return {
        text: expired ? strings.issue.call.landing.stale : strings.issue.call.landing.standing,
        tone: expired ? "yours" : "waiting",
      };
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

export function LatestNote({
  classification,
  closed,
  notes,
}: {
  classification?: Classification;
  closed: boolean;
  notes?: string;
}) {
  const blocks = notes === undefined ? [] : noteBlocks(notes);
  const latest = blocks[blocks.length - 1];
  if (closed || classification === undefined || !isYours(classification) || latest === undefined) {
    return null;
  }
  const { said, at } = noteSaid(latest);
  return (
    <p className="pw-call__ask">
      <span className="pw-call__ask-meta">
        <span className="pw-call__ask-label">{strings.issue.call.latestNote}</span>
        {at === undefined ? null : (
          <>
            <span aria-hidden="true" className="pw-call__ask-separator">
              {strings.issue.notes.separator}
            </span>
            <time className="pw-call__ask-when" dateTime={at}>
              {stamp(at)}
            </time>
          </>
        )}
      </span>
      <q className="pw-call__ask-text">{quote(said)}</q>
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
      {staleness.unresolved.map((named) => (
        <p className="pw-empty pw-empty--method" key={named.kind}>
          {named.count === 1
            ? strings.issue.stale.unresolved[named.kind].one
            : fill(strings.issue.stale.unresolved[named.kind].many, { count: String(named.count) })}
        </p>
      ))}
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

export function Notes({ authority, text }: { authority: Authority; text?: string }) {
  const blocks = text === undefined ? [] : noteBlocks(text);
  if (text === undefined || blocks.length === 0) {
    return <p className="pw-empty">{strings.issue.empty.notes}</p>;
  }
  return (
    <details className="pw-disclosure">
      <summary className="pw-disclosure__summary">
        <span className="pw-disclosure__label">
          {blocks.length === 1
            ? strings.issue.notes.one
            : fill(strings.issue.notes.count, { count: String(blocks.length) })}
        </span>
        <span aria-hidden="true" className="pw-disclosure__separator">
          {strings.issue.notes.separator}
        </span>
        <span className="pw-disclosure__hint">{strings.issue.notes.hint}</span>
      </summary>
      <Recorded authority={authority} text={text} empty={strings.issue.empty.notes} />
    </details>
  );
}

function DependencyRows({
  project,
  links,
  filter,
}: {
  project: string;
  links: IssueLink[];
  filter: FilterState;
}) {
  return (
    <>
      {links.map((link) => (
        <tr key={link.id} className="pw-row">
          <td className="pw-cell pw-cell--id">
            <IdLink project={project} id={link.id} filter={filter} />
          </td>
          <td className="pw-cell pw-cell--title">{link.title}</td>
          <td className="pw-cell pw-cell--data">{link.status}</td>
        </tr>
      ))}
    </>
  );
}

function Dependencies({ view, filter }: { view: IssueView; filter: FilterState }) {
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
          <DependencyRows project={project} links={blockedBy} filter={filter} />
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
          <DependencyRows project={project} links={blocks} filter={filter} />
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

export function shownOf(view: IssueView): IssuePreview {
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

function backLink(filter: FilterState) {
  return (
    <a className="pw-link pw-link--back" href={boardHref(filter)}>
      {strings.issue.back}
    </a>
  );
}

function failureBlock(failure?: PageFailure) {
  if (failure === undefined) {
    return null;
  }
  return (
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
}

const DONE: Record<ActionName, string> = {
  answer: strings.actions.doneAnswer,
  ready: strings.actions.doneReady,
  "not-mine": strings.actions.doneNotMine,
};

function outcomeNotice(
  id: string,
  outcome: ActionOutcome | undefined,
  ref: Ref<HTMLParagraphElement>,
): ReactNode {
  if (outcome === undefined) {
    return null;
  }
  if (!outcome.ok) {
    return (
      <p className="pw-notice pw-notice--alert" role="alert" ref={ref} tabIndex={-1}>
        {outcome.message}
      </p>
    );
  }
  return (
    <p className="pw-notice" role="status" ref={ref} tabIndex={-1}>
      {fill(DONE[outcome.action], { id })}
    </p>
  );
}

export function IssueDetail({
  shown,
  view,
  failure,
  filter = {},
  heading,
  route,
  onOutcome,
  notice,
}: {
  shown: IssuePreview;
  view?: IssueView;
  failure?: PageFailure;
  filter?: FilterState;
  heading?: Ref<HTMLHeadingElement>;
  route?: IssueRoute;
  onOutcome?: (outcome: ActionOutcome) => Promise<void>;
  notice?: ReactNode;
}) {
  const failed = failureBlock(failure);
  return (
    <>
      <div className="pw-issue__head">
        {backLink(filter)}
        <h2 className="pw-issue__title" ref={heading} tabIndex={-1}>
          {shown.title}
        </h2>
        <Call shown={shown} />
        {view === undefined ? null : (
          <LatestNote
            classification={shown.classification}
            closed={shown.closed}
            notes={view.issue.notes}
          />
        )}
        {route === undefined || onOutcome === undefined ? null : (
          <IssueActions
            route={route}
            shown={shown}
            loaded={view !== undefined}
            onOutcome={onOutcome}
          />
        )}
        {notice}
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
          filter={filter}
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
            <Notes authority={view.issue.authority} text={view.issue.notes} />
          </Band>
          <Band id="dependencies" label={strings.issue.band.dependencies} level="h3">
            <Dependencies view={view} filter={filter} />
          </Band>
          <Origin view={view} />
        </>
      )}
    </>
  );
}

export function IssuePage({
  route,
  preview,
  filter = {},
}: {
  route: IssueRoute;
  preview?: IssuePreview;
  filter?: FilterState;
}) {
  const [view, setView] = useState<IssueView | undefined>(undefined);
  const [failure, setFailure] = useState<PageFailure | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState<ActionOutcome | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const focused = useRef<string | undefined>(undefined);

  const read = useCallback(
    async (signal: AbortSignal, keep: boolean) => {
      if (!keep) {
        setView(undefined);
        setOutcome(undefined);
      }
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
    void read(controller.signal, false);
    return () => controller.abort();
  }, [read]);

  const onOutcome = useCallback(
    async (result: ActionOutcome) => {
      if (result.ok) {
        await read(new AbortController().signal, true);
      }
      setOutcome(result);
    },
    [read],
  );

  useEffect(() => {
    if (outcome !== undefined) {
      notice.current?.focus();
    }
  }, [outcome]);

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

  if (shown === undefined) {
    return (
      <>
        {backLink(filter)}
        {loading ? (
          <p className="pw-empty" role="status">
            {strings.issue.loading}
          </p>
        ) : (
          failureBlock(failure) ?? <Failure message="" />
        )}
      </>
    );
  }

  return (
    <IssueDetail
      shown={shown}
      view={view}
      failure={failure}
      filter={filter}
      heading={heading}
      route={route}
      onOutcome={onOutcome}
      notice={outcomeNotice(route.id, outcome, notice)}
    />
  );
}
