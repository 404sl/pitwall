import { test } from "node:test";
import assert from "node:assert/strict";
import { Classification } from "@404sl/pitwall-schema";
import type { Lane } from "@404sl/pitwall-schema";
import { classify } from "../src/classify.ts";
import type { ClassifyContext, UnclassifiedIssue } from "../src/classify.ts";

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
  expected: Classification;
}

const cases: Case[] = [
  {
    name: "in progress with a lane working it is in-flight",
    issue: anIssue("pitwall-a", { status: "in_progress" }),
    lanes: [aLane(1, "working", "pitwall-a")],
    expected: "in-flight",
  },
  {
    name: "in progress with no lane at all is landing",
    issue: anIssue("pitwall-a", { status: "in_progress" }),
    expected: "landing",
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
  },
  {
    name: "an [EPIC] marker in the title is an umbrella",
    issue: anIssue("pitwall-a", { title: "[EPIC] read every tracker" }),
    expected: "parked:umbrella",
  },
  {
    name: "an id that prefixes a live sibling is an umbrella with no umbrella label",
    issue: anIssue("pitwall-0lm"),
    siblings: [anIssue("pitwall-0lm.1")],
    expected: "parked:umbrella",
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
    name: "a parent in progress blocks its child",
    issue: anIssue("pitwall-a.1"),
    siblings: [anIssue("pitwall-a", { status: "in_progress" })],
    expected: "blocked",
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
  },
];

function contextFor(scenario: Case): ClassifyContext {
  return {
    issues: [scenario.issue, ...(scenario.siblings ?? [])],
    lanes: scenario.lanes ?? [],
  };
}

for (const scenario of cases) {
  test(scenario.name, () => {
    assert.equal(classify(scenario.issue, contextFor(scenario)), scenario.expected);
  });
}

test("every classification in the contract is produced by a case", () => {
  const produced = [...new Set(cases.map((scenario) => scenario.expected))].sort();
  assert.deepEqual(produced, [...Classification.options].sort());
});
