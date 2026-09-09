import type { ReactNode } from "react";

interface BandProps {
  id: string;
  label: string;
  count?: ReactNode;
  alert?: boolean;
  busy?: boolean;
  level?: "h2" | "h3";
  children: ReactNode;
}

export function Band({ id, label, count, alert = false, busy = false, level = "h2", children }: BandProps) {
  const Head = level;
  return (
    <section
      className={alert ? "pw-band pw-band--alert" : "pw-band"}
      aria-labelledby={`band-${id}`}
      aria-busy={busy ? true : undefined}
    >
      <Head className="pw-band__head" id={`band-${id}`}>
        <span className="pw-band__label">{label}</span>
        {count === undefined ? null : <span className="pw-band__count">{count}</span>}
      </Head>
      {children}
    </section>
  );
}
