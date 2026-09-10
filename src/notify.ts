import {
  resolveOrigin,
  type CollectionError,
  type Issue,
  type Origin,
  type Project,
  type PullRequest,
} from "@404sl/pitwall-schema";
import type { ClosedIssue } from "./beads.js";
import { collectionError } from "./errors.js";

export interface Notice {
  issueId: string;
  title: string;
  origin: Origin;
  pull: PullRequest | undefined;
  text: string;
}

export type Delivery = { delivered: true } | { delivered: false; reason: string };

export type Sender = (notice: Notice) => Promise<Delivery>;

export type Noter = (issueId: string, text: string) => Promise<void>;

export interface Delivered {
  notice: Notice;
  delivery: Delivery;
  error?: CollectionError;
}

export interface NoticesOptions {
  previous?: Project;
  issues: readonly Issue[];
  closed: readonly ClosedIssue[];
  sessionRef?: string;
}

export interface DeliverOptions {
  sender: Sender;
  note: Noter;
}

function pullOf(previous: Project, issueId: string): PullRequest | undefined {
  return previous.pipeline.find((pull) => pull.issueId === issueId);
}

function noticeText(issueId: string, title: string, pull: PullRequest | undefined): string {
  if (pull === undefined) {
    return `${issueId} closed: ${title}. No pull request for it was open at the previous snapshot.`;
  }
  const where = pull.url === undefined ? "" : ` ${pull.url}`;
  return `${issueId} closed: ${title}. Closed by ${pull.repo}#${pull.number}.${where}`;
}

function undeliveredText(notice: Notice, reason: string): string {
  const who = `${notice.origin.session} (${notice.origin.ref})`;
  return `Completion notice for ${who} could not be delivered: ${reason}. It said: ${notice.text}`;
}

export function noticesFor(options: NoticesOptions): Notice[] {
  const previous = options.previous;
  if (previous === undefined) {
    return [];
  }
  const wasOpen = new Set(previous.issues.map((issue) => issue.id));
  const byId = new Map([...options.issues, ...options.closed].map((issue) => [issue.id, issue]));
  const notices: Notice[] = [];
  for (const issue of options.closed) {
    if (!wasOpen.has(issue.id)) {
      continue;
    }
    const origin = resolveOrigin(issue, byId);
    if (origin === undefined || origin.ref === options.sessionRef) {
      continue;
    }
    const pull = pullOf(previous, issue.id);
    notices.push({
      issueId: issue.id,
      title: issue.title,
      origin,
      pull,
      text: noticeText(issue.id, issue.title, pull),
    });
  }
  return notices;
}

async function sent(notice: Notice, sender: Sender): Promise<Delivery> {
  try {
    return await sender(notice);
  } catch (cause) {
    return { delivered: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function lossOf(entry: Delivered): string {
  const who = `${entry.notice.origin.session} (${entry.notice.origin.ref})`;
  const what = entry.delivery.delivered
    ? `${entry.notice.issueId} notice for ${who} was delivered`
    : `${entry.notice.issueId} notice for ${who} was not delivered: ${entry.delivery.reason}`;
  return entry.error === undefined
    ? `${what}, and the reason is recorded on the issue`
    : `${what}, and could not be recorded on the issue either: ${entry.error.message}`;
}

export function undeliveredReport(delivered: readonly Delivered[]): string[] {
  return delivered
    .filter((entry) => !entry.delivery.delivered || entry.error !== undefined)
    .map(lossOf);
}

export function lostNotices(delivered: readonly Delivered[]): CollectionError[] {
  return delivered.flatMap((entry) =>
    entry.error === undefined ? [] : [{ ...entry.error, message: lossOf(entry) }],
  );
}

export async function deliver(
  notices: readonly Notice[],
  options: DeliverOptions,
): Promise<Delivered[]> {
  const delivered: Delivered[] = [];
  for (const notice of notices) {
    const delivery = await sent(notice, options.sender);
    if (delivery.delivered) {
      delivered.push({ notice, delivery });
      continue;
    }
    try {
      await options.note(notice.issueId, undeliveredText(notice, delivery.reason));
      delivered.push({ notice, delivery });
    } catch (cause) {
      delivered.push({ notice, delivery, error: collectionError(notice.issueId, cause) });
    }
  }
  return delivered;
}
