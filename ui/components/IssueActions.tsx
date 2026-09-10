import { useCallback, useState } from "react";
import { isYours } from "@404sl/pitwall-schema";
import type { IssuePreview } from "../model.js";
import { fill } from "../format.js";
import type { IssueRoute } from "../routes.js";
import { strings } from "../strings.js";

export const ACTION_HEADER = "X-Pitwall-Action";

export type ActionName = "answer" | "ready" | "not-mine";

export type ActionOutcome = { ok: true; action: ActionName } | { ok: false; message: string };

type Panel = "answer" | "not-mine";

const PANEL_ID = "pw-action-panel";
const TEXT_ID = "pw-action-text";
const HINT_ID = "pw-action-hint";

function actionUrl(route: IssueRoute, action: ActionName): string {
  return `/api/issue/${encodeURIComponent(route.project)}/${encodeURIComponent(route.id)}/${action}`;
}

function messageIn(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const value = (parsed as { message?: unknown }).message;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function IssueActions({
  route,
  shown,
  loaded,
  onOutcome,
}: {
  route: IssueRoute;
  shown: IssuePreview;
  loaded: boolean;
  onOutcome: (outcome: ActionOutcome) => Promise<void>;
}) {
  const [panel, setPanel] = useState<Panel | undefined>(() =>
    shown.classification === "yours:decision" ? "answer" : undefined,
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async (action: ActionName, written: string) => {
      setBusy(true);
      let outcome: ActionOutcome;
      try {
        const response = await fetch(actionUrl(route, action), {
          method: "POST",
          headers: { "content-type": "application/json", [ACTION_HEADER]: "1" },
          body: JSON.stringify({ text: written }),
        });
        const raw = await response.text();
        outcome = response.ok
          ? { ok: true, action }
          : { ok: false, message: messageIn(raw) ?? fill(strings.actions.failed, { id: route.id }) };
      } catch {
        outcome = { ok: false, message: strings.actions.unreachable };
      }
      await onOutcome(outcome);
      if (outcome.ok) {
        setPanel(undefined);
        setText("");
      }
      setBusy(false);
    },
    [route, onOutcome],
  );

  if (shown.closed || shown.classification === undefined || !isYours(shown.classification)) {
    return null;
  }

  const frozen = busy || !loaded;
  const state = busy ? strings.actions.writing : loaded ? undefined : strings.actions.waiting;
  const toggle = (which: Panel) => {
    setPanel(panel === which ? undefined : which);
    setText("");
  };

  return (
    <section className="pw-actions" aria-label={strings.actions.region} aria-busy={busy}>
      <div className="pw-actions__row">
        <button
          type="button"
          className="pw-button"
          disabled={frozen}
          aria-expanded={panel === "answer"}
          aria-controls={PANEL_ID}
          onClick={() => toggle("answer")}
        >
          {strings.actions.answer}
        </button>
        <button
          type="button"
          className="pw-button"
          disabled={frozen}
          onClick={() => void send("ready", "")}
        >
          {strings.actions.ready}
        </button>
        <button
          type="button"
          className="pw-button"
          disabled={frozen}
          aria-expanded={panel === "not-mine"}
          aria-controls={PANEL_ID}
          onClick={() => toggle("not-mine")}
        >
          {strings.actions.notMine}
        </button>
      </div>
      <p className="pw-actions__scope">{strings.actions.scope}</p>
      {panel === undefined ? null : (
        <form
          className="pw-actions__panel"
          id={PANEL_ID}
          onSubmit={(event) => {
            event.preventDefault();
            void send(panel, text);
          }}
        >
          <label className="pw-actions__label" htmlFor={TEXT_ID}>
            {panel === "answer" ? strings.actions.answerLabel : strings.actions.notMineLabel}
          </label>
          <p className="pw-actions__hint" id={HINT_ID}>
            {panel === "answer" ? strings.actions.answerHint : strings.actions.notMineHint}
          </p>
          <textarea
            id={TEXT_ID}
            className="pw-actions__text"
            aria-describedby={HINT_ID}
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="pw-button" disabled={frozen || text.trim() === ""}>
            {panel === "answer" ? strings.actions.answerSubmit : strings.actions.notMineSubmit}
          </button>
        </form>
      )}
      {state === undefined ? null : (
        <p className="pw-actions__state" role="status">
          {state}
        </p>
      )}
    </section>
  );
}
