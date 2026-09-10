import type { Classification, CollectionError, Staleness } from "@404sl/pitwall-schema";

export type PullState = "merged" | "open" | "closed";

export interface PullFacts {
  state: PullState;
  issueId?: string;
}

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
  structurallyBlocked: boolean;
  description?: string;
  notes?: string;
  labelledAt?: string;
  notedAt?: string;
}

export interface StalenessContext {
  idPrefix?: string;
  knownIds?: ReadonlySet<string>;
  closedIds?: ReadonlySet<string>;
  pullFacts?: (reference: PullReference) => Promise<PullFacts | undefined>;
  probe?: (command: readonly string[]) => Promise<boolean | undefined>;
  now?: Date;
}

type FailureScope = "issue" | "run";

interface Failure {
  scope: FailureScope;
  message: string;
}

interface Check {
  ran: boolean;
  fired: boolean;
  evidence: string[];
  failures?: Failure[];
}

export interface Assessment {
  staleness: Staleness;
  errors: CollectionError[];
}

export const STALENESS_SOURCE = "staleness";

export function stalenessSource(id: string): string {
  return `${STALENESS_SOURCE} ${id}`;
}

export function unresolvedCount(message: string): number {
  const leading = /^(\d+) /.exec(message);
  return leading === null ? 0 : Number(leading[1]);
}

function couldNotCheck(count: number, noun: string, verb: string, named: string[]): Failure {
  return {
    scope: "issue",
    message: `${count} ${count === 1 ? noun : `${noun}s`} could not be ${verb}: ${named.join(", ")}`,
  };
}

export const PRECONDITIONS: readonly Precondition[] = [
  { phrase: "npm whoami", command: ["npm", "whoami"] },
  { phrase: "gh auth status", command: ["gh", "auth", "status"] },
];

const DEFERRALS = ["not yet", "for later", "hold off", "on hold", "defer"];

const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g;
const NAMED_PULL = /([A-Za-z][\w.-]*)#(\d+)/g;
const BARE_PULL = /(?<!\])(^|[^\w#/-])#(\d+)\b/g;

const STOPPED_FOR_A_REASON = ["yours:", "parked:", "blocked"];
const LANDING = "landing";

type AssessmentScope = "stopped" | "landing";

function stoppedForAReason(classification: Classification): boolean {
  return STOPPED_FOR_A_REASON.some((prefix) => classification.startsWith(prefix));
}

function scopeOf(classification: Classification): AssessmentScope | undefined {
  if (classification === LANDING) {
    return "landing";
  }
  return stoppedForAReason(classification) ? "stopped" : undefined;
}

export function isAssessable(classification: Classification): boolean {
  return scopeOf(classification) !== undefined;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \S+$/;

function withoutStampLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !STAMP.test(line.trim()))
    .join("\n")
    .trim();
}

function reasonOf(record: ParkedRecord): string {
  return [record.title, record.description ?? "", withoutStampLines(record.notes ?? "")].join("\n");
}

function parkingLabel(record: ParkedRecord): string {
  return record.labels[0] ?? record.classification;
}

function instantOf(at: string | undefined): number | undefined {
  if (at === undefined) return undefined;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function noteBlocks(notes: string): string[] {
  return notes
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

function withoutStamps(block: string): string {
  const said = withoutStampLines(block);
  return said === "" ? block : said;
}

function lastNote(notes: string): string {
  const paragraphs = noteBlocks(notes);
  return withoutStamps(paragraphs[paragraphs.length - 1] ?? notes.trim());
}

export function quote(text: string): string {
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
    return { ran: false, fired: false, evidence: [] };
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
      evidence: [],
      failures: [
        {
          scope: "run",
          message: "the project records no issue id prefix, so referenced issues cannot be recognised",
        },
      ],
    };
  }
  const known = context.knownIds ?? new Set<string>();
  const closed = context.closedIds ?? new Set<string>();
  const referenced = referencedIssues(record, prefix).filter((id) => known.has(id));
  if (referenced.length === 0) {
    return { ran: false, fired: false, evidence: [] };
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
  scope: AssessmentScope,
): Promise<Check> {
  const references = referencedPulls(record);
  if (references.length === 0) {
    return { ran: false, fired: false, evidence: [] };
  }
  const resolve = context.pullFacts;
  if (resolve === undefined) {
    return {
      ran: false,
      fired: false,
      evidence: [],
      failures: [
        {
          scope: "run",
          message: "no pull request host is configured, so pull requests could not be looked up",
        },
      ],
    };
  }
  const looked = await Promise.all(
    references.map(async (reference) => ({ reference, facts: await resolve(reference) })),
  );
  const states =
    scope === "landing"
      ? looked.filter((entry) => entry.facts === undefined || entry.facts.issueId === record.id)
      : looked;
  if (states.length === 0) {
    return { ran: false, fired: false, evidence: [] };
  }
  const merged = states.filter((entry) => entry.facts?.state === "merged");
  if (merged.length > 0) {
    return {
      ran: true,
      fired: true,
      evidence: [`the pull request it waits on has merged: ${merged.map((entry) => entry.reference.text).join(", ")}`],
    };
  }
  const resolved = states.filter((entry) => entry.facts !== undefined);
  const unresolved = states.filter((entry) => entry.facts === undefined);
  const evidence = resolved.map((entry) => `${entry.reference.text} is ${entry.facts?.state}, not merged`);
  const failures =
    unresolved.length === 0
      ? []
      : [couldNotCheck(unresolved.length, "reference", "checked", unresolved.map((entry) => entry.reference.text))];
  return { ran: resolved.length > 0, fired: false, evidence, failures };
}

async function preconditionNowHolds(
  record: ParkedRecord,
  context: StalenessContext,
): Promise<Check> {
  const reason = reasonOf(record);
  const named = PRECONDITIONS.filter((precondition) => reason.includes(precondition.phrase));
  if (named.length === 0) {
    return { ran: false, fired: false, evidence: [] };
  }
  const probe = context.probe;
  if (probe === undefined) {
    return {
      ran: false,
      fired: false,
      evidence: [],
      failures: [
        {
          scope: "run",
          message: "no precondition probe is configured, so named preconditions could not be run",
        },
      ],
    };
  }
  const results = await Promise.all(
    named.map(async (precondition) => ({ precondition, passed: await probe(precondition.command) })),
  );
  const evidence: string[] = [];
  const unrunnable: string[] = [];
  let ran = false;
  let fired = false;
  for (const { precondition, passed } of results) {
    if (passed === undefined) {
      unrunnable.push(`\`${precondition.phrase}\``);
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
  const failures = unrunnable.length === 0 ? [] : [couldNotCheck(unrunnable.length, "precondition", "run", unrunnable)];
  return { ran, fired, evidence, failures };
}

const NEVER_CONCLUDED = ["yours:", "blocked", "parked:umbrella", LANDING];

function machineMayConclude(record: ParkedRecord, context: StalenessContext): boolean {
  if (record.structurallyBlocked) {
    return false;
  }
  if (NEVER_CONCLUDED.some((prefix) => record.classification.startsWith(prefix))) {
    return false;
  }
  const closed = context.closedIds ?? new Set<string>();
  return record.blockedBy.every((id) => closed.has(id));
}

function verdictOf(
  record: ParkedRecord,
  context: StalenessContext,
  checks: readonly Check[],
  at: string,
): Staleness {
  const evidence = checks.flatMap((check) => check.evidence);
  if (!checks.some((check) => check.ran)) {
    return { verdict: "unchecked", evidence };
  }
  if (!checks.some((check) => check.fired)) {
    return { verdict: "still-blocking", checkedAt: at, evidence };
  }
  if (machineMayConclude(record, context)) {
    return {
      verdict: "resolved",
      checkedAt: at,
      evidence: [...evidence, "no open dependency of its own remains"],
    };
  }
  return { verdict: "likely-stale", checkedAt: at, evidence };
}

export async function assess(
  record: ParkedRecord,
  context: StalenessContext = {},
): Promise<Assessment> {
  const scope = scopeOf(record.classification);
  const checks =
    scope === undefined
      ? []
      : scope === "landing"
        ? [await referencedPullMerged(record, context, scope)]
        : [
            noteAfterLabel(record),
            referencedIssuesClosed(record, context),
            await referencedPullMerged(record, context, scope),
            await preconditionNowHolds(record, context),
          ];
  const at = (context.now ?? new Date()).toISOString();
  return {
    staleness: verdictOf(record, context, checks, at),
    errors: checks
      .flatMap((check) => check.failures ?? [])
      .map((failure) => ({
        source: failure.scope === "issue" ? stalenessSource(record.id) : STALENESS_SOURCE,
        message: failure.message,
        at,
      })),
  };
}
