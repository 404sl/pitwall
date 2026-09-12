import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import {
  INTAKE_LABEL,
  INTAKE_ROUTE,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  megabytes,
  planningSession,
  sift,
  type RefusalKind,
} from "../../src/intake.js";
import type { FilterOption } from "../model.js";
import { fill } from "../format.js";
import { issueHref } from "../routes.js";
import { strings } from "../strings.js";
import { ACTION_HEADER } from "./IssueActions.js";

const PANEL_ID = "pw-intake-panel";
const TEXT_ID = "pw-intake-text";
const HINT_ID = "pw-intake-hint";
const PROJECT_ID = "pw-intake-project";

export interface Drop {
  files: readonly File[];
}

export type IntakeOutcome =
  | { kind: "recorded"; id: string; project: string; assignee: string; label: string; attached: number; refused: number }
  | { kind: "partial"; id: string; project: string; reason: string }
  | { kind: "failed"; message: string };

interface Answer {
  id?: unknown;
  project?: unknown;
  assignee?: unknown;
  label?: unknown;
  files?: unknown;
  reason?: unknown;
  message?: unknown;
}

function answerIn(raw: string): Answer {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Answer) : {};
  } catch {
    return {};
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function outcomeOf(ok: boolean, raw: string, refused: number): IntakeOutcome {
  const answer = answerIn(raw);
  const id = textOf(answer.id);
  const project = textOf(answer.project);
  const attached = Array.isArray(answer.files) ? answer.files.length : 0;
  if (id === undefined || project === undefined) {
    return { kind: "failed", message: textOf(answer.message) ?? strings.intake.failed };
  }
  if (!ok) {
    return { kind: "partial", id, project, reason: textOf(answer.reason) ?? "" };
  }
  return {
    kind: "recorded",
    id,
    project,
    assignee: textOf(answer.assignee) ?? planningSession(project),
    label: textOf(answer.label) ?? "",
    attached,
    refused,
  };
}

export function attachedSentence(attached: number, refused: number): string {
  const counts = strings.intake;
  if (attached === 0 && refused === 0) {
    return "";
  }
  if (attached === 0) {
    const only = refused === 1 ? counts.onlyRefused.one : fill(counts.onlyRefused.many, { count: String(refused) });
    return `${only}.`;
  }
  const some = attached === 1 ? counts.attached.one : fill(counts.attached.many, { count: String(attached) });
  if (refused === 0) {
    return `${some}.`;
  }
  const also = refused === 1 ? counts.alsoRefused.one : fill(counts.alsoRefused.many, { count: String(refused) });
  return `${some}, ${also}.`;
}

export function refusalReason(kind: RefusalKind, name: string, bytes: number): string {
  if (kind === "size") {
    return fill(strings.intake.refusedSize, {
      name,
      size: megabytes(bytes),
      cap: megabytes(MAX_FILE_BYTES),
    });
  }
  if (kind === "count") {
    return fill(strings.intake.refusedNumber, { name, count: String(MAX_FILES) });
  }
  return fill(strings.intake.refusedTotal, { name, cap: megabytes(MAX_REQUEST_BYTES) });
}

export function refusalLine(reasons: readonly string[]): string {
  if (reasons.length === 0) {
    return "";
  }
  const lead =
    reasons.length === 1
      ? strings.intake.refusedCount.one
      : fill(strings.intake.refusedCount.many, { count: String(reasons.length) });
  return [lead, ...reasons].join(" ");
}

interface Held {
  file: File;
  name: string;
  bytes: number;
  key: number;
}

export function Intake({
  projects,
  selected,
  drop,
  dropping,
}: {
  projects: readonly FilterOption[];
  selected?: string;
  drop?: Drop;
  dropping?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [held, setHeld] = useState<Held[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<IntakeOutcome | undefined>(undefined);
  const [project, setProject] = useState(() => selected ?? projects[0]?.value ?? "");
  const notice = useRef<HTMLParagraphElement>(null);
  const next = useRef(0);

  const take = useCallback((taken: readonly File[]) => {
    if (taken.length === 0) {
      return;
    }
    setHeld((before) => [
      ...before,
      ...taken.map((file) => {
        next.current += 1;
        return { file, name: file.name, bytes: file.size, key: next.current };
      }),
    ]);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (drop !== undefined) {
      take(drop.files);
    }
  }, [drop, take]);

  useEffect(() => {
    if (dropping === true) {
      setOpen(true);
    }
  }, [dropping]);

  useEffect(() => {
    if (outcome !== undefined) {
      notice.current?.focus();
    }
  }, [outcome]);

  const { accepted, refused } = sift(held);
  const refusedKeys = new Map(refused.map((entry) => [entry.key, entry.kind]));
  const reasons = refused.map((entry) => refusalReason(entry.kind, entry.name, entry.bytes));

  const send = useCallback(async () => {
    setBusy(true);
    const form = new FormData();
    form.append("text", text);
    if (project !== "") {
      form.append("project", project);
    }
    for (const entry of accepted) {
      form.append("files", entry.file, entry.name);
    }
    let result: IntakeOutcome;
    try {
      const response = await fetch(INTAKE_ROUTE, {
        method: "POST",
        headers: { [ACTION_HEADER]: "1" },
        body: form,
      });
      result = outcomeOf(response.ok, await response.text(), refused.length);
    } catch {
      result = { kind: "failed", message: strings.intake.unreachable };
    }
    setOutcome(result);
    if (result.kind === "recorded") {
      setText("");
      setHeld([]);
      setOpen(false);
    }
    setBusy(false);
  }, [text, project, accepted, refused.length]);

  const chosen = project === "" ? (projects[0]?.value ?? "") : project;
  const assignee = planningSession(chosen);
  const scope =
    projects.length === 1
      ? fill(strings.intake.scopeProject, {
          project: projects[0]?.label ?? chosen,
          assignee,
          label: INTAKE_LABEL,
        })
      : fill(strings.intake.scope, { assignee, label: INTAKE_LABEL });

  return (
    <section className="pw-intake" aria-label={strings.intake.region} aria-busy={busy}>
      <div className="pw-intake__row">
        <button
          type="button"
          className="pw-button"
          disabled={busy}
          aria-expanded={open}
          aria-controls={PANEL_ID}
          onClick={() => setOpen(!open)}
        >
          {strings.intake.open}
        </button>
      </div>
      <p className="pw-intake__scope">{scope}</p>
      {!open ? null : (
        <form
          className="pw-intake__panel"
          id={PANEL_ID}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="pw-intake__label" htmlFor={TEXT_ID}>
            {strings.intake.label}
          </label>
          <p className="pw-intake__hint" id={HINT_ID}>
            {strings.intake.hint}
          </p>
          <textarea
            id={TEXT_ID}
            className="pw-actions__text"
            aria-describedby={HINT_ID}
            rows={6}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <label className="pw-button pw-intake__file">
            {strings.intake.attach}
            <input
              type="file"
              multiple
              className="pw-sr"
              disabled={busy}
              onChange={(event) => {
                take(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </label>
          {reasons.length === 0 ? null : (
            <p className="pw-intake__refusals" role="status">
              {refusalLine(reasons)}
            </p>
          )}
          {held.length === 0 ? null : (
            <ul className="pw-intake__files">
              {held.map((entry) => {
                const kind = refusedKeys.get(entry.key);
                return (
                  <li
                    className={
                      kind === undefined
                        ? "pw-intake__file-item"
                        : "pw-intake__file-item pw-intake__file-item--refused"
                    }
                    key={entry.key}
                  >
                    <span className="pw-cell--data pw-intake__file-name">{entry.name}</span>
                    <span className="pw-intake__file-size">{megabytes(entry.bytes)}</span>
                    {kind === undefined ? null : (
                      <span className="pw-intake__file-size">{strings.intake.refusedFlag}</span>
                    )}
                    <button
                      type="button"
                      className="pw-link"
                      disabled={busy}
                      onClick={() => setHeld(held.filter((other) => other.key !== entry.key))}
                    >
                      {strings.intake.remove}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {projects.length < 2 ? null : (
            <div className="pw-filters__field">
              <label className="pw-filters__label" htmlFor={PROJECT_ID}>
                {strings.intake.project}
              </label>
              <select
                className="pw-select"
                id={PROJECT_ID}
                value={chosen}
                disabled={busy}
                onChange={(event) => setProject(event.target.value)}
              >
                {projects.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="submit"
            className="pw-button"
            disabled={busy || (text.trim() === "" && accepted.length === 0)}
          >
            {strings.intake.submit}
          </button>
        </form>
      )}
      {!busy ? null : (
        <p className="pw-intake__state" role="status">
          {strings.intake.writing}
        </p>
      )}
      <IntakeNotice outcome={outcome} notice={notice} />
    </section>
  );
}

function IntakeNotice({
  outcome,
  notice,
}: {
  outcome: IntakeOutcome | undefined;
  notice: Ref<HTMLParagraphElement>;
}) {
  if (outcome === undefined) {
    return null;
  }
  if (outcome.kind === "failed") {
    return (
      <p className="pw-notice pw-notice--alert" role="alert" ref={notice} tabIndex={-1}>
        {outcome.message}
      </p>
    );
  }
  const link = (
    <a className="pw-link" href={issueHref(outcome.project, outcome.id)}>
      {outcome.id}
    </a>
  );
  if (outcome.kind === "partial") {
    return (
      <p className="pw-notice pw-notice--alert" role="alert" ref={notice} tabIndex={-1}>
        {link} {fill(strings.intake.partial, { reason: outcome.reason })}
      </p>
    );
  }
  const files = attachedSentence(outcome.attached, outcome.refused);
  return (
    <p className="pw-notice" role="status" ref={notice} tabIndex={-1}>
      {link} {strings.intake.recorded}
      {files === "" ? "" : ` ${files}`}{" "}
      {fill(strings.intake.assigned, { assignee: outcome.assignee, label: outcome.label })}{" "}
      {strings.intake.catchUp}
    </p>
  );
}
