import { useEffect, useState } from "react";
import mark from "../brand/logo/pitwall-mark.svg";
import { fill, stamp } from "../format.js";
import { snapshotAge } from "../model.js";
import { strings } from "../strings.js";

const TICK_MS = 30_000;

interface HeaderProps {
  projectCount: number;
  generatedAt: string;
  version: string;
  update?: string;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function Header({ projectCount, generatedAt, version, update }: HeaderProps) {
  const noun = projectCount === 1 ? strings.header.project : strings.header.projects;
  const now = useNow();
  const age = snapshotAge(generatedAt, now);
  return (
    <header className={age.stale ? "pw-header pw-header--stale" : "pw-header"}>
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
          {age.stale ? (
            <>
              <span aria-hidden="true">{` · ${strings.header.staleFlag}`}</span>
              <span className="pw-sr">{strings.header.staleNotice}</span>
            </>
          ) : null}
        </span>
      </p>
    </header>
  );
}
