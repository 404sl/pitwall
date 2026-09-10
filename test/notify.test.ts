import { test } from "node:test";
import assert from "node:assert/strict";
import { Issue, Project, type Origin, type PullRequest } from "@404sl/pitwall-schema";
import type { ClosedIssue } from "../src/beads.ts";
import {
  deliver,
  noticesFor,
  type Delivery,
  type Noter,
  type Notice,
  type Sender,
} from "../src/notify.ts";

const ASKED: Origin = { session: "dev-loop", ref: "c1796a" };
const ALSO_ASKED: Origin = { session: "dev-loop", ref: "9f31bd" };
const CLOSED_AT = "2026-09-08T11:30:00Z";

const PULL = {
  repo: "site",
  number: 31,
  issueId: "mw-1",
  checks: "green",
  url: "https://github.com/404sl/pitwall/pull/31",
};

function open(id: string, origin?: Origin): Issue {
  return Issue.parse({ id, title: `${id} title`, status: "open", classification: "ready", origin });
}

function closed(id: string, origin?: Origin): ClosedIssue {
  return {
    id,
    title: `${id} title`,
    status: "closed",
    issueType: undefined,
    priority: undefined,
    labels: [],
    createdAt: undefined,
    updatedAt: CLOSED_AT,
    blockedBy: [],
    origin,
    closedAt: CLOSED_AT,
    closeReason: undefined,
  };
}

function before(issues: readonly Issue[], pipeline: readonly unknown[] = []): Project {
  return Project.parse({
    id: "mw",
    name: "mw",
    root: "/nowhere/mw",
    authority: { kind: "beads", idPrefix: "mw" },
    metrics: {},
    issues,
    pipeline,
  });
}

function recorder(delivery: Delivery = { delivered: true }): { sent: Notice[]; sender: Sender } {
  const sent: Notice[] = [];
  return {
    sent,
    sender: (notice) => {
      sent.push(notice);
      return Promise.resolve(delivery);
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

test("two sessions sharing a name are told apart by their refs", async () => {
  const notices = noticesFor({
    previous: before([open("mw-1"), open("mw-2")]),
    issues: [],
    closed: [closed("mw-1", ASKED), closed("mw-2", ALSO_ASKED)],
  });
  const { sent, sender } = recorder();
  await deliver(notices, { sender, note: noteRecorder().note });
  assert.deepEqual(
    sent.map((notice) => [notice.issueId, notice.origin.ref]),
    [
      ["mw-1", "c1796a"],
      ["mw-2", "9f31bd"],
    ],
  );
  assert.deepEqual(
    sent.map((notice) => notice.origin.session),
    ["dev-loop", "dev-loop"],
  );
});

test("the session that did the work is not interrupted by its own children", async () => {
  const notices = noticesFor({
    previous: before([open("mw-1"), open("mw-2")]),
    issues: [],
    closed: [closed("mw-1", ASKED), closed("mw-2", ALSO_ASKED)],
    sessionRef: "c1796a",
  });
  const { sent, sender } = recorder();
  const { notes, note } = noteRecorder();
  await deliver(notices, { sender, note });
  assert.deepEqual(
    sent.map((notice) => notice.issueId),
    ["mw-2"],
  );
  assert.deepEqual(notes, []);
});

test("a notice names the issue and the pull request that closed it", () => {
  const notices = noticesFor({
    previous: before([open("mw-1")], [PULL]),
    issues: [],
    closed: [closed("mw-1", ASKED)],
  });
  assert.equal(notices.length, 1);
  assert.equal((notices[0]?.pull as PullRequest | undefined)?.number, 31);
  assert.equal(
    notices[0]?.text,
    "mw-1 closed: mw-1 title. Closed by site#31. https://github.com/404sl/pitwall/pull/31",
  );
});

test("an unreachable session leaves the undelivered notice on the issue", async () => {
  const notices = noticesFor({
    previous: before([open("mw-1")], [PULL]),
    issues: [],
    closed: [closed("mw-1", ASKED)],
  });
  const { sender } = recorder({ delivered: false, reason: "no session answers to c1796a" });
  const { notes, note } = noteRecorder();
  const delivered = await deliver(notices, { sender, note });
  assert.equal(delivered[0]?.delivery.delivered, false);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.id, "mw-1");
  const text = notes[0]?.text ?? "";
  assert.match(text, /dev-loop \(c1796a\)/);
  assert.match(text, /no session answers to c1796a/);
  assert.match(text, /mw-1 closed: mw-1 title\. Closed by site#31\./);
});

test("a sender that fails outright is recorded on the issue too", async () => {
  const notices = noticesFor({
    previous: before([open("mw-1")]),
    issues: [],
    closed: [closed("mw-1", ASKED)],
  });
  const { notes, note } = noteRecorder();
  const delivered = await deliver(notices, {
    sender: () => Promise.reject(new Error("the transport is gone")),
    note,
  });
  assert.deepEqual(delivered[0]?.delivery, {
    delivered: false,
    reason: "the transport is gone",
  });
  assert.match(notes[0]?.text ?? "", /the transport is gone/);
  assert.match(notes[0]?.text ?? "", /No pull request for it was open/);
});

test("a note that cannot be written is reported rather than swallowed", async () => {
  const notices = noticesFor({
    previous: before([open("mw-1")]),
    issues: [],
    closed: [closed("mw-1", ASKED)],
  });
  const { sender } = recorder({ delivered: false, reason: "gone" });
  const delivered = await deliver(notices, {
    sender,
    note: () => Promise.reject(new Error("bd update mw-1 --append-notes: exit 1")),
  });
  assert.equal(delivered[0]?.error?.source, "mw-1");
  assert.match(delivered[0]?.error?.message ?? "", /bd update mw-1 --append-notes/);
});

test("an issue with no origin anywhere up its chain is not a notice", () => {
  assert.deepEqual(
    noticesFor({
      previous: before([open("mw-9")]),
      issues: [],
      closed: [closed("mw-9")],
    }),
    [],
  );
});

test("a child that closed carries the origin of the ancestor that has one", () => {
  const notices = noticesFor({
    previous: before([open("mw-1", ASKED), open("mw-1.1")]),
    issues: [open("mw-1", ASKED)],
    closed: [closed("mw-1.1")],
  });
  assert.deepEqual(
    notices.map((notice) => [notice.issueId, notice.origin.ref]),
    [["mw-1.1", "c1796a"]],
  );
});

test("the first collection of all announces nothing", () => {
  assert.deepEqual(noticesFor({ issues: [], closed: [closed("mw-1", ASKED)] }), []);
});

test("an issue that was already closed at the previous collection is not announced again", () => {
  assert.deepEqual(
    noticesFor({
      previous: before([open("mw-2")]),
      issues: [],
      closed: [closed("mw-4", ASKED)],
    }),
    [],
  );
});
