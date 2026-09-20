import { useEffect, useState } from "react";
import type { CollectionError } from "@404sl/pitwall-schema";
import mark from "../brand/logo/pitwall-mark.svg";
import { BuildToken } from "./Build.js";
import { fill, stamp } from "../format.js";
import { PARTIAL_SOURCE, snapshotAge, type BuildState, type ProjectAge, type SnapshotAge } from "../model.js";
import { strings } from "../strings.js";

const TICK_MS = 30_000;

interface HeaderProps {
  projectCount: number;
  generatedAt: string;
  version: string;
  update?: string;
  build?: BuildState;
  refreshFailure?: CollectionError;
  projectAges?: ProjectAge[];
}

interface Flag {
  word: string;
  notice: string;
}

function flagOf(age: SnapshotAge, failure: CollectionError | undefined): Flag | undefined {
  if (failure !== undefined) {
    return {
      word: strings.header.refreshFlag,
      notice:
        failure.source === PARTIAL_SOURCE
          ? failure.message
          : fill(strings.header.refreshNotice, { age: age.label }),
    };
  }
  return age.stale ? { word: strings.header.staleFlag, notice: strings.header.staleNotice } : undefined;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function ProjectAgeItem({ entry, now }: { entry: ProjectAge; now: number }) {
  const age = entry.readAt === undefined ? undefined : snapshotAge(entry.readAt, now);
  if (entry.readAt === undefined || age === undefined || !age.valid) {
    return (
      <span className="pw-age" title={strings.header.readAtUnknown}>
        {strings.issue.facts.none}
      </span>
    );
  }
  const at = stamp(entry.readAt);
  return (
    <>
      <span className="pw-age" title={at}>
        {age.label}
      </span>
      <time className="pw-sr" dateTime={entry.readAt}>
        {fill(strings.header.readAt, { project: entry.project, at })}
      </time>
    </>
  );
}

export function Header({
  projectCount,
  generatedAt,
  version,
  update,
  build,
  refreshFailure,
  projectAges = [],
}: HeaderProps) {
  const noun = projectCount === 1 ? strings.header.project : strings.header.projects;
  const now = useNow();
  const age = snapshotAge(generatedAt, now);
  const flag = flagOf(age, refreshFailure);
  return (
    <header className={flag === undefined ? "pw-header" : "pw-header pw-header--stale"}>
      <div className="pw-header__brand">
        <img className="pw-header__mark" src={mark} width="24" height="24" alt="" />
        <div className="pw-header__title">
          <h1 className="pw-wordmark">{strings.brand}</h1>
          <p className="pw-header__version">
            <span className="pw-sr">{`${strings.header.versionLabel} `}</span>
            {version}
            <span className="pw-header__update" role="status">
              {update === undefined ? null : (
                <>
                  <span aria-hidden="true">{" · "}</span>
                  {fill(strings.header.update, { version: update })}
                </>
              )}
            </span>
            {build === undefined ? null : <BuildToken build={build} />}
          </p>
        </div>
      </div>
      <p className="pw-header__meta" title={stamp(generatedAt)}>
        {`${projectCount} ${noun} · `}
        <span className="pw-header__age">
          {age.valid ? fill(strings.header.age, { age: age.label }) : age.label}
        </span>
        {age.valid ? (
          <time className="pw-sr" dateTime={generatedAt}>
            {fill(strings.header.takenAt, { at: stamp(generatedAt) })}
          </time>
        ) : null}
        <span className="pw-header__flag" role="status">
          {flag === undefined ? null : (
            <>
              <span aria-hidden="true">{` · ${flag.word}`}</span>
              <span className="pw-sr">{flag.notice}</span>
            </>
          )}
        </span>
      </p>
      {projectAges.length === 0 ? null : (
        <ul className="pw-header__ages" aria-label={strings.header.agesLabel}>
          {projectAges.map((entry, index) => (
            <li key={entry.projectId} className="pw-header__project">
              {index === 0 ? null : <span aria-hidden="true">{strings.filters.separator}</span>}
              <span className="pw-header__project-name">{entry.project}</span>{" "}
              <ProjectAgeItem entry={entry} now={now} />
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
