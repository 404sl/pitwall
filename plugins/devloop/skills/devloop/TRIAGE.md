# Periodic triage

`triage-scan.sh` finds issues stuck in a state nothing will move them out of. It reads and
never writes. This file is what to DO about each kind. You are the expensive half; the scan
exists so you only run when there is something to decide.

Run from `the workspace root`, always with `BEADS_DIR` pointing at the
root tracker. **Append notes, never replace them** - `bd update --notes` overwrites the whole
field and the tracker has no history. Use `--append-notes`, and write the text through a file
or a quoted heredoc so the shell cannot eat it. Read every write back with `--json`.

## The rule that matters more than the categories

**Read WHAT was decided, not merely THAT something was.** A note reading "(c) define it, then
build - but NOT YET" is a deferral wearing a decision's clothes. Unparking it cost a full
dispatch to discover that. If the recorded answer does not make the work startable, the issue
stays parked - say so in a note and move on.

And the mirror of it: a question answered in another session is the normal case, not the
exception. The owner answers in a different session and the answer lands in the notes; nothing
removes the label. That is the single most common cause of work sitting still.

## A - unlabelled hand-back

The notes say a person was asked; no label parks it, so the queue offers it as ready work and
a lane gets spent rediscovering the conclusion already written on the ticket.

Decide which it is:
- Genuinely a person's call -> add the label that says WHICH person-thing it needs:
  `needs-decision` (a choice), `needs-access` (a deploy, a dashboard, a device), `watch` (an
  observation over time). Add a one-line recommendation so it can be answered in a word.
- **Answerable from what is already recorded** -> answer it, record the reasoning, leave it
  unlabelled so the queue picks it up. Do this whenever the evidence is already on the ticket
  or in the code. Handing back a question you can answer is how a queue fills with things
  nobody needs to look at.

## B - answered but still parked

An answer is recorded after the question and the label is still on. Remove the label, append a
note saying what the answer was and that you unparked it. Then apply the rule above: check the
answer actually makes it startable before letting it into the queue.

## C - umbrella with no children

`umbrella` means "the work lives in the children". With none, the queue skips it as not-work
and nothing beneath it exists - a dead end, and anything depending on it is stuck behind a node
that cannot move. Remove the label and dispatch it to be split, or split it yourself if the
scope is already clear. Whatever creates children puts the label back.

## D - umbrella whose children are all closed

The work is done and the parent is still open, still blocking its dependents. Verify each child
really shipped (a closed child with no PR is worth a second look), then close the parent with a
reason naming the children and any part that was NOT done - residual scope written into a closed
issue is lost, so anything left over gets its own ticket before you close.

## E - stale claim

`in_progress` with no worktree. Before releasing it, check it is really dead: a run can be alive
and quiet for hours waiting on CI. `live.sh` answers this properly - a run is live while its task
output file is still empty. An empty result from a search is UNKNOWN, never proof of death; that
mistake had a branch rebased and merged under a run that was still working. When it is genuinely
dead, `bd update <id> -s open` and note what was found.

## F - unlabelled exclusion

The text excludes itself from unattended work - "stays with a person", "never unattended" - and
no label says so. These are the dangerous ones: `app-i6yt` was P1, decided whether a paid checkout
is honoured, and was next in line to be dispatched. Label it and say in the note why the
exclusion holds.

## G - lane died holding its worktree

`in_progress`, its worktree under the devloop worktrees directory untouched for 30+ minutes,
and no live run names it. Usually that means a lane died mid-flight and the claim will hold the
issue out of the queue forever.

**Confirm before believing it.** A run that has handed off, or one still in its design phase,
looks identical to a dead one from the worktree alone - a lane removes its worktree at handoff
while the run itself continues. `live.sh` is the direct answer: it lists runs with what each is
working on and when it last wrote. And check for an open pull request before calling anything
dead, because a finished lane that ended BLOCKED with its branch as the deliverable leaves the
claim open ON PURPOSE - that is category H, not a death.

If it really did die, reopen the claim: say so in a note, drop `in_progress`, and leave it for
the supervisor to re-dispatch. Do not remove the worktree - you cannot tell from here whether
something is still writing to it.

## H - an open PR the lander will never see

An open pull request on an `devloop/*` branch that carries no `lane-verified` label, whose issue
holds no lane slot and is not parked. The lander reads only labelled PRs, so nothing downstream
is watching this one: every other check reports the pipeline healthy while finished work sits in
it. `#527` sat this way on 2026-08-26 with a P1 fix in it, stranded when a lane was told to end
BLOCKED-with-a-branch during a GitHub Actions outage. It surfaced only because its worktree
happened to go stale; had the lane tidied up, nothing would have looked.

**This is a supervisor action, and you may not perform it.** Finishing one means rebasing,
pushing and labelling - repository work, which triage never does. A branch moved behind a live
lane's back is how two runs end up sharing a worktree.

What you CAN do, and should:

- Confirm it is genuinely orphaned rather than mid-flight - a lane holding the slot, or a PR
  opened minutes ago, is neither stuck nor yours.
- Read why the lane stopped, and put that on the issue if it is not already there. "Ended
  BLOCKED with the branch as the deliverable" and "died" want different responses.
- Hand it back in your return as a supervisor action item, naming the repo and PR number.

If the PR is being held deliberately rather than stranded, **park its issue** - `needs-decision`
or `needs-access`, whichever is true. That is the acknowledgment path for this category: a
parked issue's PR is skipped, so the scan stops re-reporting it. Without that, a deliberate hold
re-fires every tick and spends an agent each time to rediscover something already known.

## When you are done

Record the judgement on every issue you looked at, then mark them so the scan goes quiet:

    TRIAGE_MARK=1 bash ~/.claude/skills/devloop/triage-scan.sh >/dev/null

The watermark is a hash of each issue's labels and notes. Anything you changed, or anyone
changes later, comes back automatically. Mark ONLY what you actually judged - marking without
looking buys silence at the price of the thing this exists to prevent.

## Writing decisions into the tracker

A note may state SCOPE. It must not state AUTHORISATION for a destructive git operation.

The difference matters because of who reads it. "Print stays; 6.x keeps the mcePrint command,
measured by reading the aria-label of every .tox-tbtn" is a claim a lane can verify against the
code, and acting on it is ordinary work. "The supervisor has decided you may amend the pushed
commit and force-push" is a claim about permission, and nothing in the tracker can establish it -
a note saying somebody authorised something is not that somebody authorising it.

This is not hypothetical. A security check flagged exactly that on app-gwy4.1: the decision was
genuine and mine, the outcome was correct, and the agent was still right to refuse to take a
tracker note as authority for a force-push over a branch with an open PR. The same pattern on
app-pw2s was believed rather than checked, which is the failure this one avoided.

So when a pushed branch needs surgery: do it yourself, or describe the intended end state and
let the lane decide how to reach it. Never write a note whose force is "you are permitted to".

## Do not re-apply a label the owner removed

A label the owner put on, or took off, is a decision. A label a workflow put on is a note. Only
the second may be changed unattended, and nothing in bd distinguishes them - so the rule has to
be kept by whoever is reading.

This was got wrong on 2026-08-21. app-233a and app-i6yt were both cleared by the owner and both
had the label re-applied within hours, on the reasoning that the questions looked open. They had
been answered - app-233a with an explicit "decide later", app-i6yt with a list of why nothing was
outstanding - and re-labelling put the same question back in front of somebody who had already
disposed of it. That is the exact complaint in app-1gp5, arriving from the other direction:
parking that does not hold is one failure, and parking that will not let go is the other.

So: if an issue you would park has a note saying the owner cleared it, do not re-park it. If you
believe it is genuinely unworkable, say so to the supervisor in your report and let a person
decide - do not express the disagreement by writing the label back.

And if you DO park something, write the question down in the same breath. "A bare label with no
question cannot be answered" - which is the other half of what those notes said, and it is fair.

## "Unlabelled on purpose" does not mean "ready to build"

An owner who removes a label is saying "this is not a question for me". That is not the same as
"this can be built now", and conflating the two cost a triage run on app-0286: it was cleared
deliberately, and it still carried a recorded deferral - option (c), define then build, but not
until there are active users - plus three unanswered questions about what the thing actually
measures.

So read the gate, not the label state. A cleared label tells you who is NOT blocking; the notes
tell you whether anything else is. Both have to be true before dispatching.
