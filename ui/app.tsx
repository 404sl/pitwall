import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@404sl/pitwall-schema";
import { buildBoard, previewIssue, type FilterState, type ProblemRow } from "./model.js";
import { Band } from "./components/Band.js";
import { Failure } from "./components/Failure.js";
import { Filters, filterSentence } from "./components/Filters.js";
import { Header } from "./components/Header.js";
import { NeedsYou } from "./components/NeedsYou.js";
import { Parked } from "./components/Parked.js";
import { Problems } from "./components/Problems.js";
import { Ready } from "./components/Ready.js";
import { Running, runningSummary } from "./components/Running.js";
import { IssuePage } from "./components/IssuePage.js";
import { countLabel } from "./format.js";
import { filterOf, routeOf } from "./routes.js";
import { strings } from "./strings.js";

const SNAPSHOT_URL = "/api/snapshot";
const VERSION_URL = "/api/version";
const POLL_MS = 30_000;

interface RunningVersion {
  running: string;
  update?: string;
}

class SnapshotFailure extends Error {
  readonly source: string;

  constructor(message: string, source: string) {
    super(message);
    this.source = source;
  }
}

async function readSnapshot(signal: AbortSignal): Promise<Snapshot> {
  let response: Response;
  try {
    response = await fetch(SNAPSHOT_URL, { signal, headers: { accept: "application/json" } });
  } catch (cause) {
    if (signal.aborted) {
      throw cause;
    }
    throw new SnapshotFailure(`${strings.failure.unreachable} ${window.location.origin}.`, SNAPSHOT_URL);
  }
  const body = await response.text();
  if (!response.ok) {
    let message = body.trim();
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { message?: unknown }).message === "string") {
        message = (parsed as { message: string }).message;
      }
    } catch {
      message = body.trim();
    }
    throw new SnapshotFailure(message, `${SNAPSHOT_URL} ${response.status}`);
  }
  return JSON.parse(body) as Snapshot;
}

async function readVersion(signal: AbortSignal): Promise<RunningVersion | undefined> {
  try {
    const response = await fetch(VERSION_URL, { signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      return undefined;
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return undefined;
    }
    const { running, update } = body as { running?: unknown; update?: unknown };
    if (typeof running !== "string") {
      return undefined;
    }
    return typeof update === "string" ? { running, update } : { running };
  } catch {
    return undefined;
  }
}

function consoleProblem(cause: unknown): ProblemRow {
  const failure = cause instanceof SnapshotFailure ? cause : undefined;
  return {
    scope: "console",
    name: strings.problems.console,
    source: failure?.source ?? SNAPSHOT_URL,
    message: cause instanceof Error ? cause.message : String(cause),
    at: new Date().toISOString(),
  };
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const route = useMemo(() => routeOf(hash), [hash]);
  const filter = useMemo<FilterState>(() => filterOf(hash), [hash]);
  const [taken, setTaken] = useState<Snapshot | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [refetchFailure, setRefetchFailure] = useState<ProblemRow | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<string | undefined>(undefined);
  const held = useRef<Snapshot | undefined>(undefined);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [snapshot, running] = await Promise.all([readSnapshot(signal), readVersion(signal)]);
      if (signal.aborted) {
        return;
      }
      if (running !== undefined) {
        setVersion(running.running);
        setUpdate(running.update);
      }
      held.current = snapshot;
      setTaken(snapshot);
      setFailure(undefined);
      setRefetchFailure(undefined);
    } catch (cause) {
      if (signal.aborted) {
        return;
      }
      if (held.current === undefined) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      } else {
        setRefetchFailure(consoleProblem(cause));
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      void load(controller.signal);
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void load(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const board = useMemo(() => (taken === undefined ? undefined : buildBoard(taken, filter)), [taken, filter]);

  if (route !== undefined) {
    return (
      <>
        {board === undefined ? null : (
          <Header
            projectCount={board.projectCount}
            generatedAt={board.generatedAt}
            version={version}
            update={update}
            refreshFailed={board.refreshFailure !== undefined}
          />
        )}
        <main className="pw-console">
          <IssuePage
            route={route}
            filter={filter}
            preview={taken === undefined ? undefined : previewIssue(taken, route.project, route.id)}
          />
        </main>
      </>
    );
  }

  if (board === undefined) {
    return (
      <main className="pw-console">
        {loading ? <p className="pw-empty">{strings.empty.loading}</p> : <Failure message={failure ?? ""} />}
      </main>
    );
  }

  const problems = refetchFailure === undefined ? board.problems : [...board.problems, refetchFailure];
  const emptied = board.filtered ? filterSentence(filter, board.options) : undefined;
  const emptyOf = (total: number) => (total > 0 ? emptied : undefined);

  return (
    <>
      <Header
        projectCount={board.projectCount}
        generatedAt={board.generatedAt}
        version={version}
        update={update}
        refreshFailed={board.refreshFailure !== undefined}
      />
      <main className="pw-console">
        <Filters filter={filter} options={board.options} shown={board.issueCount} total={board.totals.issues} />
        <Band
          id="needs"
          label={strings.band.needsYou}
          count={countLabel(board.needsYouCount, board.totals.needsYou, board.filtered)}
          alert={board.totals.needsYou > 0}
        >
          <NeedsYou groups={board.needsYou} filter={filter} filteredEmpty={emptyOf(board.totals.needsYou)} />
        </Band>
        <Band
          id="running"
          label={strings.band.running}
          count={runningSummary(
            board.runningTotals,
            board.filtered ? board.totals.runningStates : undefined,
          )}
        >
          <Running rows={board.running} filter={filter} filteredEmpty={emptyOf(board.totals.running)} />
        </Band>
        <Band
          id="ready"
          label={strings.band.ready}
          count={countLabel(board.readyCount, board.totals.ready, board.filtered)}
        >
          <Ready
            rows={board.ready}
            total={board.readyCount}
            filter={filter}
            filteredEmpty={emptyOf(board.totals.ready)}
          />
        </Band>
        <Band id="parked" label={strings.band.parked}>
          <Parked
            entries={board.parked}
            totals={board.filtered ? board.totals.parked : undefined}
            filteredEmpty={emptyOf(board.totals.parked.length)}
          />
        </Band>
        <Band
          id="problems"
          label={strings.band.problems}
          count={board.filtered ? strings.filters.notFiltered : undefined}
          alert={problems.length > 0}
        >
          <Problems rows={problems} />
        </Band>
      </main>
    </>
  );
}
