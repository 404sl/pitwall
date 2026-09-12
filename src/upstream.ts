import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CollectionError, Project, PullRequest } from "@404sl/pitwall-schema";
import type { ClosedIssue } from "./beads.js";
import { collectionError, failureOf } from "./errors.js";
import { remoteOf } from "./git.js";

const run = promisify(execFile);

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 1024 * 1024;

export const CLOSE_SOURCE = "gh issue close";

const ISSUE_URL = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[?#].*)?$/i;

const NOT_SHIPPED =
  /supersed|duplicate|wont-?fix|won'?t[ -]?fix|won'?t[ -]?do|will not|not planned/i;

const SHIPPED = /^(?:landed in|merged as|merged in|fixed in|shipped in|released as)\b/i;

const SENTENCE = /[.!?](?:\s|$)/;

const REFERENCE = /(?:([A-Za-z0-9][\w./-]*)\s*)?#(\d+)|\b([0-9a-f]{7,40})\b/;

export const MAX_QUOTED = 120;

export interface UpstreamIssue {
  slug: string;
  number: number;
  url: string;
}

export interface Closure {
  issueId: string;
  issue: UpstreamIssue;
  shipped: string;
  comment: string;
}

export interface Left {
  issueId: string;
  issue: UpstreamIssue;
  reason: string;
}

export interface UpstreamWork {
  closures: Closure[];
  left: Left[];
}

export type Closed = { closed: true } | { closed: false; reason: string };

export type Closer = (closure: Closure) => Promise<Closed>;

export type Noter = (issueId: string, text: string) => Promise<void>;

export interface Reported {
  closure: Closure;
  result: Closed;
  noteError?: string;
}

export interface UpstreamRun {
  reported: Reported[];
  left: Left[];
}

export interface ClosuresOptions {
  previous?: Project;
  closed: readonly ClosedIssue[];
  slugs: readonly string[];
  unreadable?: readonly string[];
}

export interface OwnedRepos {
  slugs: string[];
  unreadable: string[];
}

export interface CloseOptions {
  closer: Closer;
  note: Noter;
}

export function upstreamIssueOf(reference: string | undefined): UpstreamIssue | undefined {
  if (reference === undefined) {
    return undefined;
  }
  const found = ISSUE_URL.exec(reference.trim());
  if (found === null) {
    return undefined;
  }
  const slug = found[1];
  const number = Number(found[2]);
  if (slug === undefined || !Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return { slug, number, url: `https://github.com/${slug}/issues/${number}` };
}

export function ownedRepos(project: Project): OwnedRepos {
  const owned: OwnedRepos = { slugs: [], unreadable: [] };
  for (const repo of project.repos) {
    const remote = remoteOf(repo.path);
    if (remote.slug !== undefined) {
      owned.slugs.push(remote.slug);
      continue;
    }
    if (remote.failure !== undefined) {
      owned.unreadable.push(`${repo.name} would not say what its origin is (${remote.failure})`);
    }
  }
  return owned;
}

function owns(slugs: readonly string[], slug: string): boolean {
  return slugs.some((owned) => owned.toLowerCase() === slug.toLowerCase());
}

function pullOf(previous: Project, issueId: string): PullRequest | undefined {
  return previous.pipeline.find((pull) => pull.issueId === issueId);
}

export function shippingSpanOf(closeReason: string | undefined): string | undefined {
  if (closeReason === undefined) {
    return undefined;
  }
  const reason = closeReason.trim();
  const verb = SHIPPED.exec(reason);
  if (verb === null) {
    return undefined;
  }
  const stop = SENTENCE.exec(reason);
  const sentence = stop === null ? reason : reason.slice(0, stop.index);
  const reference = REFERENCE.exec(sentence.slice(verb[0].length));
  if (reference === null || reference.index === undefined) {
    return undefined;
  }
  const span = sentence
    .slice(0, verb[0].length + reference.index + reference[0].length)
    .replace(/\s+/g, " ")
    .trim();
  return span === "" ? undefined : span;
}

function commentFor(issueId: string, shipped: string): string {
  return `${shipped}. Tracked as ${issueId}.`;
}

function addressed(span: string, pull: PullRequest | undefined): string {
  const found = REFERENCE.exec(span);
  const number = found?.[2];
  if (found === null || number === undefined || found[1]?.includes("/") === true) {
    return span;
  }
  const reference = /\s/.test(found[0]) ? `#${number}` : found[0];
  const url = pull !== undefined && pull.number === Number(number) ? pull.url : undefined;
  return span.replace(reference, url ?? `\`${reference}\``);
}

export function closuresFor(options: ClosuresOptions): UpstreamWork {
  const previous = options.previous;
  const work: UpstreamWork = { closures: [], left: [] };
  if (previous === undefined) {
    return work;
  }
  const unreadable = options.unreadable ?? [];
  const wasOpen = new Set(previous.issues.map((issue) => issue.id));
  for (const issue of options.closed) {
    if (!wasOpen.has(issue.id)) {
      continue;
    }
    const upstream = upstreamIssueOf(issue.externalRef);
    if (upstream === undefined) {
      continue;
    }
    if (!owns(options.slugs, upstream.slug)) {
      if (unreadable.length > 0) {
        work.left.push({
          issueId: issue.id,
          issue: upstream,
          reason: `this workspace could not tell whether ${upstream.slug} is one of its own repositories: ${unreadable.join("; ")}`,
        });
      }
      continue;
    }
    const reason = issue.closeReason;
    if (reason !== undefined && NOT_SHIPPED.test(reason)) {
      work.left.push({
        issueId: issue.id,
        issue: upstream,
        reason: `it was closed as ${reason.replace(/\s+/g, " ").trim()}, which is not something that shipped`,
      });
      continue;
    }
    const span = shippingSpanOf(reason);
    if (span === undefined) {
      work.left.push({
        issueId: issue.id,
        issue: upstream,
        reason:
          "nothing it was closed with opens by naming a pull request or a revision, so there is nothing to report as shipped",
      });
      continue;
    }
    if (span.length > MAX_QUOTED) {
      work.left.push({
        issueId: issue.id,
        issue: upstream,
        reason: `what it was closed with runs to ${span.length} characters before it names anything, which is more than is quoted onto a public issue`,
      });
      continue;
    }
    const shipped = addressed(span, pullOf(previous, issue.id));
    work.closures.push({
      issueId: issue.id,
      issue: upstream,
      shipped,
      comment: commentFor(issue.id, shipped),
    });
  }
  return work;
}

export function closeArgs(closure: Closure): string[] {
  return [
    "issue",
    "close",
    closure.issue.url,
    "--reason",
    "completed",
    "--comment",
    closure.comment,
  ];
}

export interface CloserOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function githubCloser(options: CloserOptions = {}): Closer {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return async (closure) => {
    try {
      await run("gh", closeArgs(closure), {
        encoding: "utf8",
        env,
        maxBuffer: MAX_OUTPUT,
        timeout: timeoutMs,
      });
      return { closed: true };
    } catch (cause) {
      return { closed: false, reason: failureOf(cause, timeoutMs) };
    }
  };
}

function failureText(closure: Closure, reason: string): string {
  return `${closure.issue.url} was not commented and not closed: ${reason}. It still shows this as open work, and nothing retries it.`;
}

async function asked(closure: Closure, closer: Closer): Promise<Closed> {
  try {
    return await closer(closure);
  } catch (cause) {
    return { closed: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function closeUpstream(
  closures: readonly Closure[],
  options: CloseOptions,
): Promise<Reported[]> {
  const reported: Reported[] = [];
  for (const closure of closures) {
    const result = await asked(closure, options.closer);
    if (result.closed) {
      reported.push({ closure, result });
      continue;
    }
    try {
      await options.note(closure.issueId, failureText(closure, result.reason));
      reported.push({ closure, result });
    } catch (cause) {
      reported.push({
        closure,
        result,
        noteError: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return reported;
}

function lossOf(entry: Reported): string {
  if (entry.result.closed) {
    return "";
  }
  const what = `${entry.closure.issueId} closed, but ${failureText(entry.closure, entry.result.reason)}`;
  return entry.noteError === undefined
    ? `${what} The reason is recorded on the issue.`
    : `${what} It could not be recorded on the issue either: ${entry.noteError}`;
}

export function upstreamReport(run: UpstreamRun): string[] {
  return [
    ...run.reported.filter((entry) => !entry.result.closed).map(lossOf),
    ...run.left.map(
      (entry) => `${entry.issueId} closed, and ${entry.issue.url} was left open because ${entry.reason}`,
    ),
  ];
}

export function failedClosures(run: UpstreamRun): CollectionError[] {
  return run.reported
    .filter((entry) => !entry.result.closed)
    .map((entry) => ({ ...collectionError(CLOSE_SOURCE, lossOf(entry)) }));
}
