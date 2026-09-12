import { elapsed, fill, shortSha, stamp } from "../format.js";
import type { BuildState } from "../model.js";
import { strings } from "../strings.js";

type Behind = Extract<BuildState, { kind: "behind" }>;
type Unknown = Extract<BuildState, { kind: "unknown" }>;

function ageOf(at: string | undefined, nowMs: number): string | undefined {
  if (at === undefined) {
    return undefined;
  }
  const made = Date.parse(at);
  return Number.isNaN(made) ? undefined : elapsed(Math.max(0, nowMs - made));
}

function serving(commit: string, at: string | undefined, nowMs: number): string {
  const age = ageOf(at, nowMs);
  return age === undefined
    ? fill(strings.build.servingUndated, { commit: shortSha(commit) })
    : fill(strings.build.serving, { age, commit: shortSha(commit) });
}

function stampedTitle(commit: string, at: string | undefined): string {
  return at === undefined
    ? fill(strings.build.stampedUndated, { commit })
    : fill(strings.build.stamped, { commit, at: stamp(at) });
}

function BehindBuild({ build }: { build: Behind }) {
  const now = Date.now();
  const one = build.ahead === 1;
  const headline = fill(one ? strings.build.headline.one : strings.build.headline.many, {
    count: String(build.ahead),
    branch: build.branch,
  });
  const detail = [
    serving(build.commit, build.at, now),
    fill(strings.build.at, { branch: build.branch, head: shortSha(build.head) }),
    one ? strings.build.restart.one : strings.build.restart.many,
  ].join(" ");
  const at = build.at;
  return (
    <div className="pw-build pw-build--behind">
      <p className="pw-call pw-call--yours pw-build__head">{headline}</p>
      <p className="pw-call__ask pw-build__detail" title={stampedTitle(build.commit, at)}>
        <span className="pw-call__ask-text">{detail}</span>
        {at === undefined || ageOf(at, now) === undefined ? null : (
          <time className="pw-sr" dateTime={at}>
            {fill(strings.build.servedAt, { at: stamp(at) })}
          </time>
        )}
      </p>
    </div>
  );
}

function UnknownBuild({ build }: { build: Unknown }) {
  const commit = build.commit;
  const detail =
    commit === undefined
      ? strings.build.unknown.notCurrent
      : `${serving(commit, build.at, Date.now())} ${strings.build.unknown.notCurrent}`;
  return (
    <div className="pw-build pw-build--unknown">
      <p className="pw-call pw-call--waiting pw-build__head">{strings.build.unknown.headline}</p>
      <p
        className="pw-call__ask pw-build__detail"
        title={commit === undefined ? undefined : stampedTitle(commit, build.at)}
      >
        <span className="pw-call__ask-text">{detail}</span>
      </p>
      <p className="pw-call__ask pw-build__reason">
        <span className="pw-call__ask-meta">
          <span className="pw-call__ask-label">{strings.build.unknown.reasonLabel}</span>
        </span>
        <span className="pw-call__ask-text">{build.because}</span>
      </p>
    </div>
  );
}

export function BuildBanner({ build }: { build: BuildState }) {
  if (build.kind === "behind") {
    return <BehindBuild build={build} />;
  }
  if (build.kind === "unknown") {
    return <UnknownBuild build={build} />;
  }
  return null;
}

function tokenOf(build: BuildState): { text: string; modifier?: string } | undefined {
  if (build.kind === "current") {
    return { text: strings.build.current };
  }
  if (build.kind === "behind") {
    return {
      text: fill(build.ahead === 1 ? strings.build.behindToken.one : strings.build.behindToken.many, {
        count: String(build.ahead),
      }),
      modifier: "pw-header__build-state--behind",
    };
  }
  if (build.kind === "unknown") {
    return { text: strings.build.unknownToken, modifier: "pw-header__build-state--unknown" };
  }
  return undefined;
}

export function BuildToken({ build }: { build: BuildState }) {
  const commit = build.kind === "absent" ? undefined : build.commit;
  const token = tokenOf(build);
  const className =
    token?.modifier === undefined ? "pw-header__build-state" : `pw-header__build-state ${token.modifier}`;
  return (
    <>
      {commit === undefined ? null : (
        <>
          <span className="pw-header__build-separator" aria-hidden="true">
            {" · "}
          </span>
          <span className="pw-sr">{`${strings.build.label} `}</span>
          <span className="pw-header__build">{shortSha(commit)}</span>
        </>
      )}
      <span className={className} role="status">
        {token === undefined ? null : (
          <>
            <span aria-hidden="true">{" · "}</span>
            {token.text}
          </>
        )}
      </span>
    </>
  );
}
