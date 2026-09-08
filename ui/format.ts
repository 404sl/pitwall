const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function elapsed(ms: number): string {
  if (ms < MINUTE) {
    return "<1m";
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)}m`;
  }
  if (ms < DAY) {
    return `${Math.floor(ms / HOUR)}h${Math.floor((ms % HOUR) / MINUTE)}m`;
  }
  return `${Math.floor(ms / DAY)}d${Math.floor((ms % DAY) / HOUR)}h`;
}

export function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(at);
}

export function priorityLabel(priority: number | undefined): string {
  return priority === undefined ? "—" : `P${priority}`;
}
