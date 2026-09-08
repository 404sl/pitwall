import { test } from "node:test";
import assert from "node:assert/strict";
import { Classification } from "@404sl/pitwall-schema";
import type { Lane } from "@404sl/pitwall-schema";
import { classify } from "../src/classify.ts";
import type { ClassificationReason, ClassifyContext, UnclassifiedIssue } from "../src/classify.ts";

function anIssue(id: string, over: Partial<UnclassifiedIssue> = {}): UnclassifiedIssue {
  return { id, title: id, status: "open", labels: [], blockedBy: [], ...over };
}

function aLane(slot: number, state: Lane["state"], issueId?: string): Lane {
  return { slot, state, executor: "local", issueId };
}

interface Case {
  name: string;
  issue: UnclassifiedIssue;
  siblings?: UnclassifiedIssue[];
  lanes?: Lane[];
  complete?: boolean;
  stored?: Classification;
  storedStatus?: string;
  expected: Classification;
  because?: ClassificationReason;
}

const cases: Case[] = [
  {
    name: "in progress with a lane working it is in-flight",
    issue: anIssue("pitwall-a", { status: "in_progress" }),
    lanes: [aLane(1, "working", "pitwall-a")],
    expected: "in-flight",
    because: { rule: "in-progress-lane", slot: 1 },
  },
  {
    name: "in progress with no lane at all is landing",
    issue: anIssue("pitwall-a", { status: "in_progress" }),
    expected: "landing",
    because: { rule: "in-progress-no-lane" },
  },
  {
    name: "in progress with a handed-off lane is landing, not in-flight",
    issue: anIssue("pitwall-a", { status: "in_progress" }),
    lanes: [aLane(1, "handed-off", "pitwall-a")],
    expected: "landing",
  },
  {
    name: "in progress while a lane works a different issue is landing",
    issue: anIssue("pitwall-a", { status: "in_progress" }),
    lanes: [aLane(1, "working", "pitwall-b")],
    expected: "landing",
  },
  {
    name: "needs-decision is the person's own queue",
    issue: anIssue("pitwall-a", { labels: ["needs-decision"] }),
    expected: "yours:decision",
    because: { rule: "label", label: "needs-decision" },
  },
  {
    name: "needs-access is the person's own queue",
    issue: anIssue("pitwall-a", { labels: ["needs-access"] }),
    expected: "yours:access",
  },
  {
    name: "blocked-tooling parks on tooling",
    issue: anIssue("pitwall-a", { labels: ["blocked-tooling"] }),
    expected: "parked:tooling",
  },
  {
    name: "watch parks on watch",
    issue: anIssue("pitwall-a", { labels: ["watch"] }),
    expected: "parked:watch",
  },
  {
    name: "the umbrella label parks on umbrella",
    issue: anIssue("pitwall-a", { labels: ["umbrella"] }),
    expected: "parked:umbrella",
  },
  {
    name: "roadmap parks on roadmap",
    issue: anIssue("pitwall-a", { labels: ["roadmap"] }),
    expected: "parked:roadmap",
  },
  {
    name: "needs-decision beats watch",
    issue: anIssue("pitwall-a", { labels: ["watch", "needs-decision"] }),
    expected: "yours:decision",
  },
  {
    name: "needs-access beats a parked label",
    issue: anIssue("pitwall-a", { labels: ["blocked-tooling", "needs-access"] }),
    expected: "yours:access",
  },
  {
    name: "in progress and needs-decision with a working lane is in-flight, never the inbox",
    issue: anIssue("pitwall-a", { status: "in_progress", labels: ["needs-decision"] }),
    lanes: [aLane(1, "working", "pitwall-a")],
    expected: "in-flight",
  },
  {
    name: "in progress and needs-decision with no working lane is landing, never the inbox",
    issue: anIssue("pitwall-a", { status: "in_progress", labels: ["needs-decision"] }),
    lanes: [aLane(1, "idle")],
    expected: "landing",
  },
  {
    name: "an epic type is an umbrella",
    issue: anIssue("pitwall-a", { issueType: "epic" }),
    expected: "parked:umbrella",
    because: { rule: "umbrella-type", issueType: "epic" },
  },
  {
    name: "an [EPIC] marker in the title is an umbrella",
    issue: anIssue("pitwall-a", { title: "[EPIC] read every tracker" }),
    expected: "parked:umbrella",
    because: { rule: "umbrella-title-marker" },
  },
  {
    name: "an id that prefixes a live sibling is an umbrella with no umbrella label",
    issue: anIssue("pitwall-0lm"),
    siblings: [anIssue("pitwall-0lm.1")],
    expected: "parked:umbrella",
    because: { rule: "umbrella-open-child", childId: "pitwall-0lm.1" },
  },
  {
    name: "an id that only prefixes closed siblings is not an umbrella",
    issue: anIssue("pitwall-0lm"),
    siblings: [anIssue("pitwall-0lm.1", { status: "closed" })],
    expected: "ready",
  },
  {
    name: "a numbered sibling that merely extends the id is not a child",
    issue: anIssue("pitwall-a.1"),
    siblings: [anIssue("pitwall-a"), anIssue("pitwall-a.10")],
    expected: "ready",
  },
  {
    name: "an unrelated id that happens to start with this one is not a child",
    issue: anIssue("pitwall-a"),
    siblings: [anIssue("pitwall-ab")],
    expected: "ready",
  },
  {
    name: "an issue is not an umbrella of itself",
    issue: anIssue("pitwall-0lm"),
    expected: "ready",
  },
  {
    name: "an umbrella outranks its own unclosed dependency",
    issue: anIssue("pitwall-a", { issueType: "epic", blockedBy: ["pitwall-b"] }),
    siblings: [anIssue("pitwall-b")],
    expected: "parked:umbrella",
  },
  {
    name: "an unclosed dependency edge blocks",
    issue: anIssue("pitwall-a", { blockedBy: ["pitwall-b"] }),
    siblings: [anIssue("pitwall-b")],
    expected: "blocked",
    because: { rule: "blocked-open", ids: ["pitwall-b"] },
  },
  {
    name: "a dependency edge on a closed issue does not block",
    issue: anIssue("pitwall-a", { blockedBy: ["pitwall-b"] }),
    siblings: [anIssue("pitwall-b", { status: "closed" })],
    expected: "ready",
  },
  {
    name: "a dependency edge on an issue absent from the snapshot does not block",
    issue: anIssue("pitwall-a", { blockedBy: ["pitwall-gone"] }),
    expected: "ready",
  },
  {
    name: "a dependency edge on an issue absent from an incomplete collection blocks",
    issue: anIssue("pitwall-a", { blockedBy: ["pitwall-gone"] }),
    complete: false,
    expected: "blocked",
    because: { rule: "blocked-unreadable", ids: ["pitwall-gone"] },
  },
  {
    name: "an incomplete collection does not block an edge on an issue it did carry as closed",
    issue: anIssue("pitwall-a", { blockedBy: ["pitwall-b"] }),
    siblings: [anIssue("pitwall-b", { status: "closed" })],
    complete: false,
    expected: "ready",
  },
  {
    name: "a parent in progress blocks its child",
    issue: anIssue("pitwall-a.1"),
    siblings: [anIssue("pitwall-a", { status: "in_progress" })],
    expected: "blocked",
    because: { rule: "blocked-parent-in-progress", parentId: "pitwall-a" },
  },
  {
    name: "a parent that is merely open does not block its child",
    issue: anIssue("pitwall-a.1"),
    siblings: [anIssue("pitwall-a")],
    expected: "ready",
  },
  {
    name: "an open issue with nothing against it is ready",
    issue: anIssue("pitwall-a"),
    expected: "ready",
    because: { rule: "default" },
  },
  {
    name: "a classification carried by the tracker's own status needs no dependency edge",
    issue: anIssue("pitwall-a"),
    stored: "blocked",
    expected: "blocked",
  },
  {
    name: "a parked classification carried by the tracker's own status is kept",
    issue: anIssue("pitwall-a"),
    stored: "parked:roadmap",
    storedStatus: "deferred",
    expected: "parked:roadmap",
    because: { rule: "stored-status", status: "deferred" },
  },
  {
    name: "a label naming somebody's queue outranks what the tracker's status says",
    issue: anIssue("pitwall-a", { labels: ["needs-decision"] }),
    stored: "blocked",
    expected: "yours:decision",
  },
];

function contextFor(scenario: Case): ClassifyContext {
  return {
    issues: [scenario.issue, ...(scenario.siblings ?? [])],
    lanes: scenario.lanes ?? [],
    collectionComplete: scenario.complete ?? true,
    stored:
      scenario.stored === undefined
        ? undefined
        : new Map([
            [
              scenario.issue.id,
              { classification: scenario.stored, status: scenario.storedStatus ?? "deferred" },
            ],
          ]),
  };
}

for (const scenario of cases) {
  test(scenario.name, () => {
    const classified = classify(scenario.issue, contextFor(scenario));
    assert.equal(classified.classification, scenario.expected);
    if (scenario.because !== undefined) {
      assert.deepEqual(classified.reason, scenario.because);
    }
  });
}

test("every rule the precedence walk can take names itself", () => {
  const rules = new Set(
    cases
      .filter((scenario) => scenario.because !== undefined)
      .map((scenario) => scenario.because?.rule),
  );
  assert.deepEqual(
    [...rules].sort(),
    [
      "blocked-open",
      "blocked-parent-in-progress",
      "blocked-unreadable",
      "default",
      "in-progress-lane",
      "in-progress-no-lane",
      "label",
      "stored-status",
      "umbrella-open-child",
      "umbrella-title-marker",
      "umbrella-type",
    ],
  );
});

test("a closed issue is not classified at all, whatever an open one with its fields would be", () => {
  const context: ClassifyContext = { issues: [], lanes: [], collectionComplete: true };
  const decided = anIssue("pitwall-a", { status: "closed", labels: ["needs-decision"] });
  const epic = anIssue("pitwall-b", { status: "closed", issueType: "epic" });
  const plain = anIssue("pitwall-c", { status: "closed" });
  for (const issue of [decided, epic, plain]) {
    const classified = classify(issue, { ...context, issues: [issue] });
    assert.equal(classified.classification, undefined, `${issue.id} kept an active classification`);
    assert.deepEqual(classified.reason, { rule: "closed" });
  }
  assert.equal(
    classify({ ...plain, status: "open" }, { issues: [], lanes: [], collectionComplete: true })
      .classification,
    "ready",
    "the same issue left open is still classified",
  );
});

test("a reason names the blocker it read rather than one it could not", () => {
  const issue = anIssue("pitwall-a", { blockedBy: ["pitwall-b", "pitwall-gone"] });
  const context: ClassifyContext = {
    issues: [issue, anIssue("pitwall-b")],
    lanes: [],
    collectionComplete: false,
  };
  assert.deepEqual(classify(issue, context).reason, { rule: "blocked-open", ids: ["pitwall-b"] });
});

test("every classification in the contract is produced by a case", () => {
  const produced = [...new Set(cases.map((scenario) => scenario.expected))].sort();
  assert.deepEqual(produced, [...Classification.options].sort());
});
