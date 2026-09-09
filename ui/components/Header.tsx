import { useEffect, useState } from "react";
import mark from "../brand/logo/pitwall-mark.svg";
import { fill, stamp } from "../format.js";
import { snapshotAge } from "../model.js";
import { strings } from "../strings.js";

const TICK_MS = 30_000;

interface HeaderProps {
  projectCount: number;
  generatedAt: string;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function Header({ projectCount, generatedAt }: HeaderProps) {
  const noun = projectCount === 1 ? strings.header.project : strings.header.projects;
  const now = useNow();
  const age = snapshotAge(generatedAt, now);
  return (
    <header className={age.stale ? "pw-header pw-header--stale" : "pw-header"}>
      <div className="pw-header__brand">
        <img className="pw-header__mark" src={mark} width="24" height="24" alt="" />
        <h1 className="pw-wordmark">{strings.brand}</h1>
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
      </p>
      <span className="pw-sr" role="status">
        {age.stale ? strings.header.staleNotice : ""}
      </span>
    </header>
  );
}
