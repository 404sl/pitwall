import mark from "../brand/logo/pitwall-mark.svg";
import { clock, stamp } from "../format.js";
import { strings } from "../strings.js";

interface HeaderProps {
  projectCount: number;
  generatedAt: string;
}

export function Header({ projectCount, generatedAt }: HeaderProps) {
  const noun = projectCount === 1 ? strings.header.project : strings.header.projects;
  return (
    <header className="pw-header">
      <div className="pw-header__brand">
        <img className="pw-header__mark" src={mark} width="24" height="24" alt="" />
        <h1 className="pw-wordmark">{strings.brand}</h1>
      </div>
      <p className="pw-header__meta" title={stamp(generatedAt)}>
        {`${projectCount} ${noun} · ${clock(generatedAt)}`}
      </p>
    </header>
  );
}
