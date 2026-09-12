import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { Snapshot } from "@404sl/pitwall-schema";
import type { BuildStamp, BuildVerdict, CheckoutState, UnknownReason } from "../src/build.js";
import {
  buildBoard,
  buildState,
  previewIssue,
  type BuildState,
  type FilterState,
  type ProblemRow,
  type RunningVersion,
} from "./model.js";
import { Band } from "./components/Band.js";
import { BuildBanner } from "./components/Build.js";
import { Failure } from "./components/Failure.js";
import { Filters, filterSentence } from "./components/Filters.js";
import { Header } from "./components/Header.js";
import { carriesFiles, Intake, type Drop } from "./components/Intake.js";
import { NeedsYou } from "./components/NeedsYou.js";
import { Parked } from "./components/Parked.js";
import { Problems } from "./components/Problems.js";
import { Ready } from "./components/Ready.js";
import { Running, runningSummary } from "./components/Running.js";
import { Today } from "./components/Today.js";
import { IssuePage } from "./components/IssuePage.js";
import { countLabel } from "./format.js";
import { filterOf, routeOf } from "./routes.js";
import { strings } from "./strings.js";

const SNAPSHOT_URL = "/api/snapshot";
const VERSION_URL = "/api/version";
const POLL_MS = 30_000;

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

function stampOf(value: unknown): BuildStamp | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { commit, at } = value as { commit?: unknown; at?: unknown };
  if (typeof commit !== "string") {
    return undefined;
  }
  return typeof at === "string" ? { commit, at } : { commit };
}

function checkoutOf(value: unknown): CheckoutState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { branch, head, ahead } = value as { branch?: unknown; head?: unknown; ahead?: unknown };
  if (typeof branch !== "string" || typeof head !== "string") {
    return undefined;
  }
  return Number.isInteger(ahead) ? { branch, head, ahead: ahead as number } : { branch, head };
}

function verdictOf(value: unknown): BuildVerdict | undefined {
  return value === "current" || value === "behind" || value === "unknown" || value === "no-checkout"
    ? value
    : undefined;
}

function becauseOf(value: unknown): UnknownReason | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { kind, message } = value as { kind?: unknown; message?: unknown };
  if (kind === "no-stamp" || kind === "diverged") {
    return { kind };
  }
  return kind === "checkout" && typeof message === "string" ? { kind, message } : undefined;
}

function buildFields(body: Record<string, unknown>): Omit<RunningVersion, "running" | "update"> {
  const build = stampOf(body.build);
  const checkout = checkoutOf(body.checkout);
  const buildCheck = verdictOf(body.buildCheck);
  const unknownBecause = becauseOf(body.unknownBecause);
  return {
    ...(build === undefined ? {} : { build }),
    ...(checkout === undefined ? {} : { checkout }),
    ...(buildCheck === undefined ? {} : { buildCheck }),
    ...(unknownBecause === undefined ? {} : { unknownBecause }),
  };
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
    return {
      running,
      ...(typeof update === "string" ? { update } : {}),
      ...buildFields(body as Record<string, unknown>),
    };
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
  const [build, setBuild] = useState<BuildState>(() => buildState({ kind: "waiting" }));
  const [dropping, setDropping] = useState(false);
  const [drop, setDrop] = useState<Drop | undefined>(undefined);
  const held = useRef<Snapshot | undefined>(undefined);
  const dragging = useRef(0);

  const load = useCallback(async (signal: AbortSignal) => {
    const [snapshot, running] = await Promise.allSettled([readSnapshot(signal), readVersion(signal)]);
    if (signal.aborted) {
      return;
    }
    if (running.status === "fulfilled") {
      const answered = running.value;
      if (answered !== undefined) {
        setVersion(answered.running);
        setUpdate(answered.update);
      }
      setBuild(buildState(answered === undefined ? { kind: "unanswered" } : { kind: "read", version: answered }));
    }
    if (snapshot.status === "fulfilled") {
      held.current = snapshot.value;
      setTaken(snapshot.value);
      setFailure(undefined);
      setRefetchFailure(undefined);
    } else {
      const cause: unknown = snapshot.reason;
      if (held.current === undefined) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      } else {
        setRefetchFailure(consoleProblem(cause));
      }
    }
    setLoading(false);
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

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    dragging.current += 1;
    setDropping(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (carriesFiles(event)) {
      event.preventDefault();
    }
  }, []);

  const onDragLeave = useCallback(() => {
    dragging.current = Math.max(0, dragging.current - 1);
    if (dragging.current === 0) {
      setDropping(false);
    }
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    dragging.current = 0;
    setDropping(false);
    setDrop({ files: Array.from(event.dataTransfer.files) });
  }, []);

  if (route !== undefined) {
    return (
      <>
        {board === undefined ? null : (
          <Header
            projectCount={board.projectCount}
            generatedAt={board.generatedAt}
            version={version}
            update={update}
            build={build}
            refreshFailure={board.refreshFailure}
          />
        )}
        <main className="pw-console">
          <BuildBanner build={build} />
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
        <BuildBanner build={build} />
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
        build={build}
        refreshFailure={board.refreshFailure}
      />
      <main
        className={dropping ? "pw-console pw-console--dropping" : "pw-console"}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <BuildBanner build={build} />
        <Filters filter={filter} options={board.options} shown={board.issueCount} total={board.totals.issues} />
        <Intake
          projects={board.options.project}
          selected={filter.project}
          drop={drop}
          dropping={dropping}
        />
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
          id="today"
          label={strings.band.today}
          count={board.filtered ? strings.filters.notFiltered : undefined}
        >
          <Today today={board.today} />
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
