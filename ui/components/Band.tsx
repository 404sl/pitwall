import type { ReactNode } from "react";

interface BandProps {
  id: string;
  label: string;
  count?: ReactNode;
  alert?: boolean;
  children: ReactNode;
}

export function Band({ id, label, count, alert = false, children }: BandProps) {
  return (
    <section className={alert ? "pw-band pw-band--alert" : "pw-band"} aria-labelledby={`band-${id}`}>
      <h2 className="pw-band__head" id={`band-${id}`}>
        <span className="pw-band__label">{label}</span>
        {count === undefined ? null : <span className="pw-band__count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}
