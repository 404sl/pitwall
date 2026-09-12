import { test } from "node:test";
import assert from "node:assert/strict";
import { Issue, Project } from "@404sl/pitwall-schema";
import type { ClosedIssue } from "../src/beads.ts";
import {
  CLOSE_SOURCE,
  closeArgs,
  closeUpstream,
  closuresFor,
  failedClosures,
  MAX_QUOTED,
  shippingSpanOf,
  upstreamIssueOf,
  upstreamReport,
  type Closed,
  type Closure,
  type Noter,
  type UpstreamRun,
} from "../src/upstream.ts";

const OURS = "404sl/pitwall";
const CLOSED_AT = "2026-09-11T09:00:00Z";

const PULL = {
  repo: "site",
  number: 92,
  issueId: "pw-1wh",
  checks: "green",
  url: "https://github.com/404sl/pitwall/pull/92",
};

function open(id: string, title = `${id} title`): Issue {
  return Issue.parse({ id, title, status: "open", classification: "ready" });
}

function closed(
  id: string,
  fields: { title?: string; externalRef?: string; closeReason?: string } = {},
): ClosedIssue {
  return {
    id,
    title: fields.title ?? `${id} title`,
    status: "closed",
    issueType: undefined,
    priority: undefined,
    labels: [],
    createdAt: undefined,
    updatedAt: CLOSED_AT,
    blockedBy: [],
    origin: undefined,
    closedAt: CLOSED_AT,
    closeReason: fields.closeReason,
    externalRef: fields.externalRef,
  };
}

function before(issues: readonly Issue[], pipeline: readonly unknown[] = []): Project {
  return Project.parse({
    id: "pw",
    name: "pw",
    root: "/nowhere/pw",
    authority: { kind: "beads", idPrefix: "pw" },
    metrics: {},
    issues,
    pipeline,
  });
}

function closer(result: Closed = { closed: true }): { asked: Closure[]; close: (c: Closure) => Promise<Closed> } {
  const asked: Closure[] = [];
  return {
    asked,
    close: (closure) => {
      asked.push(closure);
      return Promise.resolve(result);
    },
  };
}

function noteRecorder(): { notes: { id: string; text: string }[]; note: Noter } {
  const notes: { id: string; text: string }[] = [];
  return {
    notes,
    note: (id, text) => {
      notes.push({ id, text });
      return Promise.resolve();
    },
  };
}

function run(reported: UpstreamRun["reported"], left: UpstreamRun["left"] = []): UpstreamRun {
  return { reported, left };
}

test("a bead closing closes the issue it came from, naming what the close reason says shipped", async () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", {
        externalRef: `https://github.com/${OURS}/issues/39`,
        closeReason: "Landed in cli #92",
      }),
    ],
    slugs: [OURS],
  });
  assert.equal(work.closures.length, 1);
  assert.deepEqual(work.left, []);
  assert.equal(work.closures[0]?.issue.number, 39);
  assert.equal(
    work.closures[0]?.comment,
    "Landed in cli https://github.com/404sl/pitwall/pull/92. Tracked as pw-1wh.",
  );
  const { asked, close } = closer();
  const reported = await closeUpstream(work.closures, { closer: close, note: noteRecorder().note });
  assert.deepEqual(
    asked.map((closure) => closure.issue.url),
    ["https://github.com/404sl/pitwall/issues/39"],
  );
  assert.equal(reported[0]?.result.closed, true);
  assert.deepEqual(upstreamReport(run(reported)), []);
  assert.deepEqual(failedClosures(run(reported)), []);
});

test("the close reason names what shipped when no pull request was open at the last collection", () => {
  const work = closuresFor({
    previous: before([open("pw-cpn")]),
    closed: [
      closed("pw-cpn", {
        externalRef: `https://github.com/${OURS}/issues/60`,
        closeReason: "Landed in cli #91 - NOT deployed, see below",
      }),
    ],
    slugs: [OURS],
  });
  assert.equal(work.closures[0]?.comment, "Landed in cli `#91`. Tracked as pw-cpn.");
});

test("a close reason carrying no pull request or revision leaves the issue open", () => {
  const work = closuresFor({
    previous: before([open("pw-jam")]),
    closed: [
      closed("pw-jam", {
        externalRef: `https://github.com/${OURS}/issues/59`,
        closeReason: "Fixed in the shared skill by another session and verified here",
      }),
    ],
    slugs: [OURS],
  });
  assert.deepEqual(work.closures, []);
  assert.equal(work.left.length, 1);
  assert.match(work.left[0]?.reason ?? "", /opens by naming a pull request or a revision/);
  assert.match(
    upstreamReport(run([], work.left))[0] ?? "",
    /pw-jam closed, and https:\/\/github\.com\/404sl\/pitwall\/issues\/59 was left open/,
  );
});

test("a bead closed with no reason at all, with an open pull request in the pipeline, closes nothing", () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [closed("pw-1wh", { externalRef: `https://github.com/${OURS}/issues/39` })],
    slugs: [OURS],
  });
  assert.deepEqual(work.closures, []);
  assert.equal(work.left.length, 1);
  assert.match(work.left[0]?.reason ?? "", /opens by naming a pull request or a revision/);
});

test("a pull request merely open at the last collection is never the evidence that something shipped", () => {
  const reasons = [
    "Does not reproduce.",
    "Filed on the wrong tracker",
    "Promoted out of roadmap",
    "Closed in favour of the smaller change",
  ];
  for (const closeReason of reasons) {
    const work = closuresFor({
      previous: before([open("pw-1wh")], [PULL]),
      closed: [
        closed("pw-1wh", {
          externalRef: `https://github.com/${OURS}/issues/39`,
          closeReason,
        }),
      ],
      slugs: [OURS],
    });
    assert.deepEqual(work.closures, [], closeReason);
    assert.equal(work.left.length, 1, closeReason);
    assert.match(work.left[0]?.reason ?? "", /opens by naming a pull request or a revision/);
  }
});

test("a number no open pull request of this bead corroborates is not turned into a link", () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", {
        externalRef: `https://github.com/${OURS}/issues/39`,
        closeReason: "Landed in cli #55, which is not the pull request the pipeline carried",
      }),
    ],
    slugs: [OURS],
  });
  assert.equal(work.closures[0]?.comment, "Landed in cli `#55`. Tracked as pw-1wh.");
});

test("a reference written against its repository without a space is replaced whole, not spliced", () => {
  const shipped = (pipeline: readonly unknown[]) =>
    closuresFor({
      previous: before([open("pw-1wh")], pipeline),
      closed: [
        closed("pw-1wh", {
          externalRef: `https://github.com/${OURS}/issues/39`,
          closeReason: "Merged as pitwall-site#23 (3c53c57)",
        }),
      ],
      slugs: [OURS],
    }).closures[0]?.comment;
  assert.equal(
    shipped([{ ...PULL, number: 23, url: "https://github.com/404sl/pitwall-site/pull/23" }]),
    "Merged as https://github.com/404sl/pitwall-site/pull/23. Tracked as pw-1wh.",
  );
  assert.equal(shipped([PULL]), "Merged as `pitwall-site#23`. Tracked as pw-1wh.");
});

test("a reference that already names its repository travels unchanged", () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", {
        externalRef: `https://github.com/${OURS}/issues/39`,
        closeReason: "Merged as 404sl/pitwall#90 (3c53c57)",
      }),
    ],
    slugs: [OURS],
  });
  assert.equal(work.closures[0]?.comment, "Merged as 404sl/pitwall#90. Tracked as pw-1wh.");
});

test("a shared title is never the link - only the recorded external-ref is", () => {
  const sameTitle = "A killed step is reported as failed";
  const work = closuresFor({
    previous: before([open("pw-one", sameTitle), open("pw-two", sameTitle)]),
    closed: [
      closed("pw-one", { title: sameTitle, closeReason: "Merged as 404sl/pitwall#90" }),
      closed("pw-two", {
        title: sameTitle,
        externalRef: `https://github.com/${OURS}/issues/59`,
        closeReason: "Merged as 404sl/pitwall#90",
      }),
    ],
    slugs: [OURS],
  });
  assert.deepEqual(
    work.closures.map((closure) => [closure.issueId, closure.issue.number]),
    [["pw-two", 59]],
  );
  assert.deepEqual(work.left, []);
});

test("superseded, duplicate and won't-do are never reported to the issue as shipped", () => {
  const reasons = [
    "Superseded by pw-ea3, which merged as 1f7ac96",
    "Duplicate of pw-6tyc, closed into it and merged as 404sl/pitwall#94",
    "Won't do - the behaviour is wanted, landed in cli #92 only as a test",
    "Closed as not planned",
  ];
  for (const closeReason of reasons) {
    const work = closuresFor({
      previous: before([open("pw-1")], [PULL]),
      closed: [
        closed("pw-1", { externalRef: `https://github.com/${OURS}/issues/39`, closeReason }),
      ],
      slugs: [OURS],
    });
    assert.deepEqual(work.closures, [], closeReason);
    assert.equal(work.left.length, 1, closeReason);
    assert.match(work.left[0]?.reason ?? "", /is not something that shipped/);
  }
});

test("a ship named in a later sentence is not this bead's ship, whatever it says", () => {
  const reasons = [
    "Out of scope for this tracker. Related work landed in cli #92",
    "Closed at the reporter's request; the same area was fixed in cli #92 last week",
    "No longer reproducible after the proxy change. Merged as 404sl/pitwall#92",
  ];
  for (const closeReason of reasons) {
    const work = closuresFor({
      previous: before([open("pw-1wh")], [PULL]),
      closed: [
        closed("pw-1wh", {
          externalRef: `https://github.com/${OURS}/issues/39`,
          closeReason,
        }),
      ],
      slugs: [OURS],
    });
    assert.deepEqual(work.closures, [], closeReason);
    assert.equal(work.left.length, 1, closeReason);
    assert.match(work.left[0]?.reason ?? "", /opens by naming a pull request or a revision/);
  }
});

test("a remark between the ship and the reference never travels onto a public issue", () => {
  const closeReason =
    "Landed in cli. The reporter is wrong about the cause and we are not telling them; the real culprit was their own proxy. #92";
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", { externalRef: `https://github.com/${OURS}/issues/39`, closeReason }),
    ],
    slugs: [OURS],
  });
  assert.deepEqual(work.closures, []);
  assert.equal(work.left.length, 1);
  assert.ok(!(work.left[0]?.reason ?? "").includes("not telling them"));
});

test("a shipping statement too long to quote leaves the issue open and says so", () => {
  const closeReason = `Landed in cli after the customer's own proxy turned out to be the real culprit ${"and the cache was cold ".repeat(
    3,
  )}#92`;
  assert.ok(shippingSpanOf(closeReason) !== undefined);
  assert.ok((shippingSpanOf(closeReason) ?? "").length > MAX_QUOTED);
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", { externalRef: `https://github.com/${OURS}/issues/39`, closeReason }),
    ],
    slugs: [OURS],
  });
  assert.deepEqual(work.closures, []);
  assert.match(work.left[0]?.reason ?? "", /more than is quoted onto a public issue/);
});

test("a checkout that would not say what its origin is is reported, not read as a foreign reference", () => {
  const shipped = (unreadable: readonly string[]) =>
    closuresFor({
      previous: before([open("pw-1wh")], [PULL]),
      closed: [
        closed("pw-1wh", {
          externalRef: `https://github.com/${OURS}/issues/39`,
          closeReason: "Landed in cli #92",
        }),
      ],
      slugs: [],
      unreadable,
    });
  const told = shipped(["cli would not say what its origin is (fatal: not a git repository)"]);
  assert.deepEqual(told.closures, []);
  assert.equal(told.left.length, 1);
  assert.match(told.left[0]?.reason ?? "", /could not tell whether 404sl\/pitwall is one of its own/);
  assert.match(told.left[0]?.reason ?? "", /fatal: not a git repository/);
  assert.deepEqual(shipped([]).left, []);
});

test("an external-ref outside this workspace's repositories is left alone", () => {
  const refs = [
    "https://session-replay.com/replays/e5QfEEjBkaPuvxwGyjn2vw",
    "https://github.com/someone/else/issues/7",
    "https://github.com/404sl/pitwall/pull/92",
    "not a url at all",
  ];
  for (const externalRef of refs) {
    const work = closuresFor({
      previous: before([open("pw-1")], [PULL]),
      closed: [closed("pw-1", { externalRef, closeReason: "Merged as 404sl/pitwall#92" })],
      slugs: [OURS],
    });
    assert.deepEqual(work.closures, [], externalRef);
    assert.deepEqual(work.left, [], externalRef);
  }
});

test("the first collection of all closes nothing, and a bead already closed is not closed again", () => {
  const issue = closed("pw-1wh", {
    externalRef: `https://github.com/${OURS}/issues/39`,
    closeReason: "Merged as 404sl/pitwall#92",
  });
  assert.deepEqual(closuresFor({ closed: [issue], slugs: [OURS] }).closures, []);
  assert.deepEqual(
    closuresFor({ previous: before([open("pw-other")]), closed: [issue], slugs: [OURS] }).closures,
    [],
  );
});

test("a close that fails is recorded on the bead and reported as a collection error", async () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", {
        externalRef: `https://github.com/${OURS}/issues/39`,
        closeReason: "Landed in cli #92",
      }),
    ],
    slugs: [OURS],
  });
  const { close } = closer({ closed: false, reason: "HTTP 403: Resource not accessible" });
  const { notes, note } = noteRecorder();
  const reported = await closeUpstream(work.closures, { closer: close, note });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.id, "pw-1wh");
  assert.match(notes[0]?.text ?? "", /was not commented and not closed: HTTP 403/);
  assert.match(notes[0]?.text ?? "", /nothing retries it/);
  const lines = upstreamReport(run(reported));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /HTTP 403: Resource not accessible/);
  assert.match(lines[0] ?? "", /recorded on the issue/);
  const failures = failedClosures(run(reported));
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.source, CLOSE_SOURCE);
  assert.equal(failures[0]?.message, lines[0]);
});

test("a failure that cannot even be recorded on the bead is reported, not swallowed", async () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", {
        externalRef: `https://github.com/${OURS}/issues/39`,
        closeReason: "Landed in cli #92",
      }),
    ],
    slugs: [OURS],
  });
  const reported = await closeUpstream(work.closures, {
    closer: () => Promise.reject(new Error("gh: command not found")),
    note: () => Promise.reject(new Error("bd update pw-1wh --append-notes: no beads database")),
  });
  assert.deepEqual(reported[0]?.result, { closed: false, reason: "gh: command not found" });
  const lines = upstreamReport(run(reported));
  assert.match(lines[0] ?? "", /gh: command not found/);
  assert.match(lines[0] ?? "", /could not be recorded on the issue either: bd update pw-1wh/);
});

test("the only thing this ever asks GitHub to do is close an issue", () => {
  const work = closuresFor({
    previous: before([open("pw-1wh")], [PULL]),
    closed: [
      closed("pw-1wh", {
        externalRef: `https://github.com/${OURS}/issues/39`,
        closeReason: "Landed in cli #92",
      }),
    ],
    slugs: [OURS],
  });
  const closure = work.closures[0] as Closure;
  assert.deepEqual(closeArgs(closure), [
    "issue",
    "close",
    "https://github.com/404sl/pitwall/issues/39",
    "--reason",
    "completed",
    "--comment",
    "Landed in cli https://github.com/404sl/pitwall/pull/92. Tracked as pw-1wh.",
  ]);
});

test("the quoted close reason starts at the reason and stops at the reference it names", () => {
  assert.equal(shippingSpanOf("Landed in cli #92 - NOT deployed, see below"), "Landed in cli #92");
  assert.equal(
    shippingSpanOf("Merged as 404sl/pitwall#94 (44cc687). Plugin version bumped"),
    "Merged as 404sl/pitwall#94",
  );
  assert.equal(shippingSpanOf("Merged as 4d0d206 (PR #14, squashed)"), "Merged as 4d0d206");
  assert.equal(shippingSpanOf("  Landed in cli #92"), "Landed in cli #92");
  assert.equal(shippingSpanOf("Does not reproduce. Measured on the rendered pages"), undefined);
  assert.equal(shippingSpanOf("Out of scope. Related work landed in cli #92"), undefined);
  assert.equal(shippingSpanOf("Superseded by pw-ea3, which merged as 1f7ac96"), undefined);
  assert.equal(shippingSpanOf("Landed in cli. Measured again afterwards on #92"), undefined);
  assert.equal(shippingSpanOf(undefined), undefined);
});

test("an issue reference is read from the url and nothing else", () => {
  assert.deepEqual(upstreamIssueOf("https://github.com/404sl/pitwall/issues/39"), {
    slug: "404sl/pitwall",
    number: 39,
    url: "https://github.com/404sl/pitwall/issues/39",
  });
  assert.equal(upstreamIssueOf("404sl/pitwall#39"), undefined);
  assert.equal(upstreamIssueOf("https://github.com/404sl/pitwall/issues/0"), undefined);
  assert.equal(upstreamIssueOf(undefined), undefined);
});
