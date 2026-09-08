import type { Classification, Staleness } from "@404sl/pitwall-schema";

export type PullState = "merged" | "open" | "closed";

export interface PullReference {
  number: number;
  repo: string | undefined;
  url: string | undefined;
  text: string;
}

export interface Precondition {
  phrase: string;
  command: readonly string[];
}

export interface ParkedRecord {
  id: string;
  title: string;
  classification: Classification;
  labels: readonly string[];
  blockedBy: readonly string[];
  description?: string;
  notes?: string;
  labelledAt?: string;
  notedAt?: string;
}

export interface StalenessContext {
  idPrefix?: string;
  knownIds?: ReadonlySet<string>;
  closedIds?: ReadonlySet<string>;
  pullState?: (reference: PullReference) => Promise<PullState | undefined>;
  probe?: (command: readonly string[]) => Promise<boolean | undefined>;
  now?: Date;
}

interface Check {
  ran: boolean;
  fired: boolean;
  evidence: string[];
}

export const PRECONDITIONS: readonly Precondition[] = [
  { phrase: "npm whoami", command: ["npm", "whoami"] },
  { phrase: "gh auth status", command: ["gh", "auth", "status"] },
];

const DEFERRALS = ["not yet", "for later", "hold off", "on hold", "defer"];

const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g;
const NAMED_PULL = /([A-Za-z][\w.-]*)#(\d+)/g;
const BARE_PULL = /(?<!\])(^|[^\w#/-])#(\d+)\b/g;

const ASSESSABLE = ["yours:", "parked:", "blocked"];

export function isAssessable(classification: Classification): boolean {
  return ASSESSABLE.some((prefix) => classification.startsWith(prefix));
}

function reasonOf(record: ParkedRecord): string {
  return [record.title, record.description ?? "", record.notes ?? ""].join("\n");
}

function parkingLabel(record: ParkedRecord): string {
  return record.labels[0] ?? record.classification;
}

function instantOf(at: string | undefined): number | undefined {
  if (at === undefined) return undefined;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function lastNote(notes: string): string {
  const paragraphs = notes
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  return paragraphs[paragraphs.length - 1] ?? notes.trim();
}

function quote(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function defersRatherThanAnswers(note: string): boolean {
  const lowered = note.toLowerCase();
  return DEFERRALS.some((marker) => lowered.includes(marker));
}

function noteAfterLabel(record: ParkedRecord): Check {
  const label = parkingLabel(record);
  const labelled = instantOf(record.labelledAt);
  const noted = instantOf(record.notedAt);
  if (labelled === undefined || noted === undefined) {
    return {
      ran: false,
      fired: false,
      evidence: [
        `the tracker does not record when the ${label} label was applied, so a note written after it cannot be recognised`,
      ],
    };
  }
  if (noted <= labelled) {
    return {
      ran: true,
      fired: false,
      evidence: [`nothing has been recorded since the ${label} label went on at ${record.labelledAt}`],
    };
  }
  const note = lastNote(record.notes ?? "");
  if (defersRatherThanAnswers(note)) {
    return {
      ran: true,
      fired: false,
      evidence: [
        `the note recorded at ${record.notedAt}, after the ${label} label, defers rather than answers: "${quote(note)}"`,
      ],
    };
  }
  return {
    ran: true,
    fired: true,
    evidence: [
      `a note was recorded at ${record.notedAt}, after the ${label} label went on at ${record.labelledAt}: "${quote(note)}"`,
    ],
  };
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referencedIssues(record: ParkedRecord, prefix: string): string[] {
  const pattern = new RegExp(`\\b${escapeForPattern(prefix)}-[a-z0-9]+(?:\\.[0-9]+)*\\b`, "g");
  const found = reasonOf(record).match(pattern) ?? [];
  return [...new Set(found)].filter((id) => id !== record.id);
}

function referencedIssuesClosed(record: ParkedRecord, context: StalenessContext): Check {
  const prefix = context.idPrefix;
  if (prefix === undefined || prefix === "") {
    return {
      ran: false,
      fired: false,
      evidence: ["the project records no issue id prefix, so referenced issues cannot be recognised"],
    };
  }
  const known = context.knownIds ?? new Set<string>();
  const closed = context.closedIds ?? new Set<string>();
  const referenced = referencedIssues(record, prefix).filter((id) => known.has(id));
  if (referenced.length === 0) {
    return {
      ran: false,
      fired: false,
      evidence: ["it names no other issue of this project"],
    };
  }
  const open = referenced.filter((id) => !closed.has(id));
  if (open.length > 0) {
    return {
      ran: true,
      fired: false,
      evidence: [`it names ${open.join(", ")}, still open`],
    };
  }
  return {
    ran: true,
    fired: true,
    evidence: [`every issue it names has since closed: ${referenced.join(", ")}`],
  };
}

function referencedPulls(record: ParkedRecord): PullReference[] {
  const reason = reasonOf(record);
  const found = new Map<string, PullReference>();
  for (const [text, repo, number] of reason.matchAll(PULL_URL)) {
    found.set(text, { number: Number(number), repo, url: text, text });
  }
  for (const [text, repo, number] of reason.matchAll(NAMED_PULL)) {
    if (!found.has(text)) {
      found.set(text, { number: Number(number), repo, url: undefined, text });
    }
  }
  for (const [, lead, number] of reason.matchAll(BARE_PULL)) {
    const text = `#${number}`;
    if (lead !== undefined && !found.has(text)) {
      found.set(text, { number: Number(number), repo: undefined, url: undefined, text });
    }
  }
  return [...found.values()];
}

async function referencedPullMerged(
  record: ParkedRecord,
  context: StalenessContext,
): Promise<Check> {
  const references = referencedPulls(record);
  if (references.length === 0) {
    return { ran: false, fired: false, evidence: ["it names no pull request"] };
  }
  const resolve = context.pullState;
  if (resolve === undefined) {
    return {
      ran: false,
      fired: false,
      evidence: [`no pull request host is configured, so ${references[0]?.text} could not be looked up`],
    };
  }
  const states = await Promise.all(
    references.map(async (reference) => ({ reference, state: await resolve(reference) })),
  );
  const merged = states.filter((entry) => entry.state === "merged");
  if (merged.length > 0) {
    return {
      ran: true,
      fired: true,
      evidence: [`the pull request it waits on has merged: ${merged.map((entry) => entry.reference.text).join(", ")}`],
    };
  }
  const resolved = states.filter((entry) => entry.state !== undefined);
  const unresolved = states.filter((entry) => entry.state === undefined);
  const evidence = resolved.map((entry) => `${entry.reference.text} is ${entry.state}, not merged`);
  for (const entry of unresolved) {
    evidence.push(`could not resolve ${entry.reference.text} to a pull request`);
  }
  return { ran: resolved.length > 0, fired: false, evidence };
}

async function preconditionNowHolds(
  record: ParkedRecord,
  context: StalenessContext,
): Promise<Check> {
  const reason = reasonOf(record);
  const named = PRECONDITIONS.filter((precondition) => reason.includes(precondition.phrase));
  if (named.length === 0) {
    return {
      ran: false,
      fired: false,
      evidence: ["the recorded reason names no condition that can be tested from here"],
    };
  }
  const probe = context.probe;
  if (probe === undefined) {
    return {
      ran: false,
      fired: false,
      evidence: [`the recorded reason names \`${named[0]?.phrase}\`, which was not run`],
    };
  }
  const results = await Promise.all(
    named.map(async (precondition) => ({ precondition, passed: await probe(precondition.command) })),
  );
  const evidence: string[] = [];
  let ran = false;
  let fired = false;
  for (const { precondition, passed } of results) {
    if (passed === undefined) {
      evidence.push(`\`${precondition.phrase}\` could not be run from here`);
      continue;
    }
    ran = true;
    if (passed) {
      fired = true;
      evidence.push(`the recorded reason rests on \`${precondition.phrase}\`, which now succeeds`);
    } else {
      evidence.push(`the recorded reason rests on \`${precondition.phrase}\`, which still fails`);
    }
  }
  return { ran, fired, evidence };
}

const NEVER_CONCLUDED = ["yours:", "blocked", "parked:umbrella"];

function machineMayConclude(record: ParkedRecord, context: StalenessContext): boolean {
  if (NEVER_CONCLUDED.some((prefix) => record.classification.startsWith(prefix))) {
    return false;
  }
  const closed = context.closedIds ?? new Set<string>();
  return record.blockedBy.every((id) => closed.has(id));
}

export async function assess(
  record: ParkedRecord,
  context: StalenessContext = {},
): Promise<Staleness> {
  const checks = [
    noteAfterLabel(record),
    referencedIssuesClosed(record, context),
    await referencedPullMerged(record, context),
    await preconditionNowHolds(record, context),
  ];
  const evidence = checks.flatMap((check) => check.evidence);
  if (!checks.some((check) => check.ran)) {
    return { verdict: "unchecked", evidence };
  }
  const checkedAt = (context.now ?? new Date()).toISOString();
  if (!checks.some((check) => check.fired)) {
    return { verdict: "still-blocking", checkedAt, evidence };
  }
  if (machineMayConclude(record, context)) {
    return {
      verdict: "resolved",
      checkedAt,
      evidence: [...evidence, "no open dependency of its own remains"],
    };
  }
  return { verdict: "likely-stale", checkedAt, evidence };
}
