---
name: devloop
description: Work a project backlog unattended - pick eligible open issues by priority, design any UI change, fix each in its own git worktree, review adversarially, and label the green pull request lane-verified; a separate serial lander then rebases, merges, deploys and closes. Use when asked to work through the backlog, fix open issues automatically, run the dev loop, land finished pull requests, or keep N workflows running on the tracker.
---

# Devloop

Runs the backlog without a person in the loop. One pool of lanes, each lane taking issues
one at a time and carrying each from tracker to deployed.

**It merges to master and deploys on its own.** That is the point of it, and it is the
reason for the design gate, the adversarial reviewer and the exclusion list. Do not loosen
those to make it finish more.

## Filing tickets

Anything this pipeline files - a split child, a follow-up, a bug found in passing - follows
`WRITING-TICKETS.md` in this directory. One instruction, the traps, a link to the evidence,
checkable acceptance. Nothing else.

## Shape

A **supervisor loop** in the session, **one background workflow per issue**, and **one
serial lander**. The loop owns concurrency; a task workflow only knows how to finish one
thing properly. A crashed workflow costs one issue, not the run.

`queue.sh` is the whole state, with no agent and no tokens. `task.js` is one issue.
`land.js` is everything that is finished.

## Lanes hand off; the lander lands

Changed 2026-08-23, under app-enoh. A lane no longer merges or deploys. Its last phase gets
the PR green, checks the body and the commits for compliance, and adds the GitHub label
**`lane-verified`**. Then it stops, leaving the issue open and `in_progress`.

`land.js` does the rest, one PR at a time: master must be green, rebase only if behind,
resolve a textual conflict but hand back a conflict of meaning, wait for CI on the new head,
merge, confirm the master run. It deploys staging **and** production together once at the
end and again every ten merges, then closes the issues - and closes nothing if the deploy
did not succeed.

**The label is the interface, not the tracker.** Tracker status was wrong often enough that
the owner asked for the two to be untangled: the label is written by the lane that did the
work and read by the lander, and nothing else writes it.

Why: eight lanes each rebased, pushed, waited for CI, and found master had moved because
another lane merged during the wait - so they rebased and waited again. One branch did that
three times and spent 4h26m shipping 43 minutes of work, and the cost grew with the number
of lanes. The old merge lock serialised the merge but not the rebase-and-wait in front of it.

**Never pick a slot from memory. Ask `slot.sh`.** A dispatch has no number left to pick:
`config.sh --args <id>` calls `slot.sh` itself, carries the number it reserved into the args, and
stops the dispatch when it cannot reserve one. Call `slot.sh` by hand to give a lane back, or to
see who holds what.

```
slot=$(bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/slot.sh <issue-id>)   # reserves it, prints the number
bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/slot.sh --release <issue-id> # a run that never reported
bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/slot.sh --list               # who holds what
```

**A run gives its own lane and slot back, whatever way it ends.** `task.js` and `rework.js` release
them in a `finally`, so a split, a `needs_feedback`, a `blocked`, a `red`, a handoff that failed and
an exception all go through it, and `release-lane.sh` proves ownership from the owner file beside
the lock and the id in the slot file before removing anything. `--release` above is for a run that never reported at
all - killed, crashed, or a supervisor that lost its context. A lane or a slot that was not given
back is named in the run's log whatever way the run ended, and a run that got past triage carries
the outcome for both in its result as well - so a leak arrives in the answer rather than in
somebody's memory. A run that bounced at triage - a dead triage agent, a split, a `needs_feedback` -
has built its result before the release step answers, so for those three the log is the only place
it appears. Every `rework.js` ending but an exception carries both answers, because the endings that
used to return early set a result instead.

A rework dispatched without a slot gives only the lane back. `config.sh --args` always reserves one,
so that is the hand-built args object the dispatch documents rather than anything the pipeline
produces - and slot 1, which the script falls back to for `TEST_ENV_NUMBER`, is whichever run
actually reserved it. Its reservation is not this run's to remove.

The slot number IS the test database - task.js derives `TEST_ENV_NUMBER` from it - so two lanes
on one slot share a database. `slot.sh` checks the lane lock before handing a number out, which
memory cannot do. Four collisions happened on 2026-08-23 from picking numbers by hand, and then
a fifth after that lesson was supposedly learned: slot 7 was reused for `app-seyb` because
`app-12lw` had finished on it, forgetting `app-9q71` was also there. That run refused to start
and cost 153k tokens to discover a fact `slot.sh --list` prints instantly.

Its registry is a file per slot under `/tmp/<lockPrefix>-slots` and it goes stale across sessions -
it held seven finished issues from a previous day while five different lanes were live, which
would have answered "all lanes busy". When it disagrees with the locks, the LOCKS ARE THE FACT:
rebuild the registry from them rather than trusting either blindly, and never run `--gc` right
after dispatching, because a lane takes its lock minutes into the run and looks idle until then.

**Six lanes, not eight.** Set 2026-08-23 by the owner, and it is a throughput number rather
than a preference. The lander costs about fifteen minutes a PR - rebase, push, CI, merge, then
a second CI wait to confirm master survived - so it lands roughly four an hour. Eight lanes
produce five or six, about half of them bouncing or splitting instead, so the queue grew by
one or two an hour and never drained. Past the lander's rate, another lane does not ship
anything sooner; it only adds to what is finished and waiting.

If the queue is still growing at six, take lanes off before touching the lander: the
post-merge master CI wait is the check that would have caught six PRs batch-merged into a red
master on the morning of 2026-08-23, and it is not the thing to trade for speed.

**`in_progress` no longer means a lane is working on it.** A lane hands off at a labelled PR
and leaves the issue in_progress for the lander to close after deploy, so the status covers
both "being worked" and "finished, waiting to go live". `queue.sh` splits them - "running now"
counts lanes with a worktree touched in the last twenty minutes, "awaiting lander" is the rest.
Dispatch against "running now"; the raw in_progress count once read 19 when 7 lanes were live.

**READ THE TICKET BEFORE DISPATCHING IT. `bd ready` answers a narrower question than
"is this workable".** It honours dependency EDGES and nothing else. A ticket whose ordering
lives in its description or notes - "do not do this earlier", "X lands first", "depends on the
row Y creates" - reads as ready and is not.

This cost three dispatches on 2026-08-27 alone, each a lane spent to be told something already
written on the ticket:

  app-24l1     design said "rewrite these sentences in the SAME PR that makes them false, DO
              NOT DO IT EARLIER". Its only edge pointed at an unrelated closed issue.
  app-jxjo     description specified an email capture, notes argued for OAuth; nothing recorded
              which shipped, so no lane could pick.
  app-w23d.4   whole mechanism keys off a threadId column that the still-open app-w23d.3 creates.
              No edge existed; the table does not exist on master.

CHECK THE TYPE FIRST, because it is cheaper than reading. An issue whose type is `epic`, or
whose title carries `[EPIC]`, is a CONTAINER and is never dispatchable - a lane sent at one
bounces immediately on an explicit ineligibility rule. `bd ready` offers epics like anything
else, and an epic with children that are all blocked looks exactly like ordinary ready work.
app-nwpc was dispatched this way on 2026-08-27 with five children already broken out. If it is
an epic, label it `umbrella` and dispatch the READY CHILD instead - and read `bd ready` for
which child that is rather than the epic's prose, which named the wrong one.

So before `slot.sh <id>`: check it is not an epic, then read the description and the notes, and
ask whether anything there names another issue, a sequence, or an unanswered question. If it does, RECORD IT AS AN EDGE
(`bd dep add <this> <blocker>`) or as a park label, then move on to the next candidate. The
edge is what stops it happening again - a note explaining the ordering is exactly what the
queue could not read the first time.

**The supervisor launches the lander. Nothing else does.** At every tick, after dispatching:

```
gh pr list --state open --label lane-verified --json number   # in each repo

# Then, FOR EVERY PR that listed - not just the first, not just the ones you doubt:
gh pr view <n> --repo 404sl/<slug> --json labels,statusCheckRollup

# Then hand it the list you just looked at. It merges those and nothing else.
args=$(bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/config.sh --land \
         404sl/pitwall#588 404sl/pitwall-schema#111)

Workflow({ scriptPath: <the scriptPath that object carries>,
           args: <the object config.sh printed> })
```

Launch it when any repo has a labelled PR and no lander run is already going. It takes
`/tmp/<lockPrefix>-merge.lock` itself and gives it back on every exit path, so a second run and a
person merging by hand both wait rather than collide - but two launches still waste a run,
so check first. Without this step the pipeline's output is labelled PRs sitting forever.

**Run that middle command for every queued PR before launching, in this session's own
transcript.** It is not a formality and it is not the lander's job done twice.

**AND RE-RUN IT ON EVERY RELAUNCH, over the queue as it is THEN.** The evidence covers the
pull requests you actually named, and a lander run takes long enough that lanes finish during
it - their pull requests arrive labelled, behind a supervisor that has never queried them. On
2026-08-27 a batch landed five and was blocked on three (#538, #542, #544) for exactly this:
the pre-flight had covered the six queued at launch, and those three did not exist yet. The
run is not wasted - the lander reports them as agent_error and the merges simply do not
happen - but nothing lands until the query is run and the lander is relaunched.

So treat a lander relaunch as needing its own full pre-flight, never as a resumption of the
last one. `gh pr list --label lane-verified` first, THEN `gh pr view` each number the list
returned, THEN launch. Do not carry a number over from the previous batch's query and assume
it still counts; query the whole current queue every time, including the ones you checked an
hour ago. The cost is one call per PR and the alternative is a silent stall.

The merge exception in the machine's `autoMode` allow rules requires, in the owner's own
words, that "an earlier tool call in the same transcript is a `gh pr view` on that same pull
request number requesting `labels` and `statusCheckRollup`". A subagent running it inside its
own transcript does not appear to satisfy that - on 2026-08-25/26 six merges were refused in a
row for exactly this, each naming the PR number whose query was missing. The one clean drain
of that night was eight PRs queried here first and then landed with zero refusals.

The ordering matters as much as the doing. A PR that gains its label AFTER a lander run has
started will be refused however carefully it was checked, because the check has to precede the
delegation. So query the queue, then launch; do not launch and then query, and re-query if the
queue changed while you were deciding.

**`preflighted` is that list, written down.** Give it every PR you just ran `gh pr view` on,
as `owner/name#number`. The lander intersects its own survey against it and reports anything
else as `SKIPPED <pr> - not pre-flighted, lands next run`, without spending a worktree, a
rebase and a full CI wait to arrive at a refusal it could predict. It only ever merges FEWER PRs than
before, never more, so it cannot turn an unchecked PR into a merged one - and a PR it skips
keeps its label and lands on the next run, whose pre-flight will have seen it.

Two ways to get it wrong, both quiet:

- **Name the repository by its GitHub slug, the same `owner/name` you passed to `--repo`.** A
  key from `.autofix.json` is accepted and rewritten to that repository's slug, but the slug is
  what the lander keys on, and it is the only form that cannot mean two repositories: a key is
  this workspace's label, and `site` is the CLI checkout here while also being the obvious word
  for the website repo. Pull request numbers repeat across repositories, so the wrong pairing
  does not fail - it names a real, different pull request. A repository matching nothing filters
  that PR out as though it were never labelled; the lander says `pre-flighted but never
  surveyed: ...` at the end of a run for exactly this, and that line is the only warning you
  get.
- **Omitting the field means no filtering at all**, which is the old behaviour and is safe;
  passing `[]` means land nothing. An empty list is not the way to say "I did not check".

Skipping the field is not a shortcut for skipping the queries. The queries are what make the
merge permissible; the list only stops the lander from trying merges that were never going to
be permitted.

`land.js` also asks the same question itself now, immediately before spawning each merge, and
skips a PR that is unlabelled, red or carrying an empty rollup. That check exists for its own
sake - a label vanished mid-run once, and a rebased head was red while its label still said
otherwise - and it is a different guarantee from this one. Do both.

## One issue

```
# BUILD THE ARGS WITH config.sh. Do not hand-write them, and do not pass a slot.
args=$(bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/config.sh --args app-1056)

Workflow({ scriptPath: <the scriptPath that object carries>,
           args: <the object config.sh printed> })
```

**`{ id, slot }` alone is not enough and fails in a way that looks like the lane's
fault.** task.js reads its project configuration OUT OF `args` and never from disk - it
is a workflow script and has no filesystem access - so a dispatch built by hand carries
no `root`, no `repos`, no `idPrefix`. The lane then has no test command, no repository
paths and an id prefix that matches nothing, and it fails several minutes in, somewhere
that reads as a broken ticket rather than a broken dispatch.

`config.sh --args <id>` exists to build that object and is the only supported way to do
it. This example used to show the short form, which was correct only for the one workspace
whose values happen to be task.js's defaults.

**It also reserves the lane, which is why no slot is passed any more.** The number used to be
the caller's to choose and the reservation a separate step the caller was trusted to remember -
so the two could disagree, and nothing asked. `--args` now calls `slot.sh <id>`, which records
the reservation and consults the lane lock in the same step, and passes on the number it got.
When no lane can be reserved it prints nothing and exits non-zero: a full pool, a locked lane or
a parked issue stops the dispatch rather than sending a run at a guessed database. A trailing
number is still accepted for the sake of `queue.sh`, which reserves before it prints, and it is
CHECKED against the reservation rather than used instead of it - one that disagrees is refused,
naming both.

**THE SCRIPT YOU DISPATCH IS A COPY, AND `--args` MAKES IT FRESH.** The Workflow tool refuses
a `scriptPath` outside the working directory, so the workflow scripts cannot be dispatched from
the install. `run-script.sh` copies all four into `<root>/.autofix-run/` and prints the path of
the one asked for; `config.sh --args` and `--land` call it before they print anything and carry
the result as `scriptPath`. So take the path out of the object and dispatch that - never a path
under the install, and never one remembered from an earlier tick.

It copies unconditionally, every time, without comparing or checking a version. That is the
whole design: a copy that is rewritten at every dispatch cannot be stale, and there is nothing
for anybody to notice or act on. Each copy is written under a temporary name and renamed into
place, so a run that re-reads its script cannot see half a file.

```
bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/run-script.sh rework.js   # when no --args mode fits
```

Absolute path - the tool does not resolve `~`. `slot` is the lane `--args` reserved, and it
only sets `TEST_ENV_NUMBER` so concurrent site runs do not share a test database; two live
workflows must never carry the same one, which is what reserving it is for. Other args:
`maxAttempts` (3), `root`, `worktrees`.

## When a lane dies

**Ask `lane-running.sh <id>` before you believe it.** It is the only thing that answers "is a
lane for this id running right now": the harness creates a task output file empty at dispatch
and writes it when the run ends, and the session transcript ties that task to the workflow
whose journal labels its phases with the issue id. It answers `RUNNING`, `NOT-RUNNING` or
`UNKNOWN`, and **`UNKNOWN` is not dead** - nothing may act on it as though it were.

Nothing else answers the question, and each of the four signals that look like they do is
silently wrong rather than merely narrow:

| signal | what it actually answers |
|---|---|
| slot claim | a lane **started**, ever - written at dispatch, outlives the lane |
| lane lock | a lane reached the locking phase **and still holds it** |
| `TaskList` | **nothing about lanes, ever.** It lists `TaskCreate` to-do items and has never listed a workflow. `TaskGet` on a live workflow's own id answers "Task not found". An empty result is not evidence. |
| worktree | a directory exists - a dead lane leaves one, and a live lane can be missing one |

A supervisor tore down a healthy lane 42 minutes into its run on the strength of an empty
`TaskList`. It survived only because it rebuilt its worktree and carried on.

`lanes.sh` then names the suspect and says whether its workflow transcript is still moving - a
transcript silent for longer than the staleness window means nothing is running, whatever the
worktree looks like. A lane goes quiet whenever it is reading rather than writing, so worktree
age alone cannot tell a slow lane from a dead one.

Stop the workflow with `TaskStop`, then clean up with **one command**, not by hand:

```bash
kill-lane.sh --slot 2 --id app-4m7h            # --dry-run first if unsure
```

`kill-lane.sh` asks `lane-running.sh` first and refuses on `RUNNING` and on `UNKNOWN`; `--force`
is the override once you have confirmed by hand. `slot.sh --gc` asks it too and keeps any slot it
cannot prove idle.

It attributes a workflow by the script it was dispatched from, because the scripts do not label
alike: a `task.js` journal whose labels are not this id belongs to another issue, so does a
`rework.js` journal whose every label carries an id and none of them is this one, `land.js` and
`land-train.js` are no issue's lane, and anything else is `UNKNOWN`. A rework lane that was
already in flight before this shipped labels its phases by pull request number alone, which
names no issue - so while it runs EVERY id reads `UNKNOWN`, `slot.sh --gc` frees nothing and
`kill-lane.sh` refuses for all of them. Confirm it by hand rather than forcing past it, because
its worktree holds the conflict resolution it is writing.

`kill-lane.sh` also exits 7 when the worktree it is about to remove is mid-rebase or mid-merge,
whatever the verdict said. A lander is no issue's lane, but `land.js` tells it to reuse a
worktree that already holds the branch, so a lane's worktree can be somebody's live rebase while
the id itself is genuinely `NOT-RUNNING`.

**Before starting a train, ask `lane-running.sh --any`.** It answers the same question about the
whole workspace - is ANY lane in flight - and `queue-watch.sh` gates its READY TO LAND event on
it: `RUNNING` keeps the gate shut, and `UNKNOWN` announces that it cannot tell rather than
announcing that nothing is running. A `RUNNING` whose workflow directory has not been written to
for longer than `--stale-minutes` (default 20, the window `lanes.sh` uses) is announced as well,
naming the task, the workflow and how long it has been silent. An issue re-dispatched after a
supervisor stop or a launch crash leaves every abandoned run reading `RUNNING` for ever, so the
event judges only the newest-writing run for each issue and says which one of how many it
judged - an earlier dispatch is not evidence about that issue. A run whose age cannot be measured
at all - nothing under its workflow directory can be stat'd - says `journal age unknown`, a third
state beside the annotation and its absence. It is counted as a dispatch of its issue and then not
judged: read as a writer it would silence the report for every other run of the same issue, and
read as silence it would put the kill recommendation behind a failed stat. It stays `RUNNING` and the gate
stays shut - a lane waiting on CI writes nothing for half an hour - but a task orphaned at
dispatch reads `RUNNING` for as long as its empty output file exists, and that used to hold the
event shut in silence. The gate used to count `lanes.sh` rows through a pattern fixed to one
project's id prefix, so it read zero in every other workspace and said "ready to land, no lanes
running" three times in one day with three lanes live. A train started over a live lane moves
master underneath every running branch.

`lanes.sh` reads the registry this workspace's `lockPrefix` names and refuses rather than falling
back to the default, which had it reporting "no lanes have ever been claimed" while three slots
were claimed under the prefix the config names.

A lane holds four things and a hand cleanup reliably gets three. On 2026-08-30 app-4m7h was
cleaned up by hand - worktree removed, branch deleted, slot freed - and the lane lock was left
behind. The re-dispatch then refused to start, correctly: from inside a lane a stale lock and a
live one look identical, and breaking somebody else's means two runs resetting the same test
database mid-suite with neither being told. So the re-dispatch burned a lane doing nothing.

The lock is the one that gets forgotten because it is the only one whose name is not the issue
id - **slot N takes lane N+1**, and that off-by-one is exactly what a hand cleanup misses. The
script also refuses to delete a branch that reached origin, since a pull request may point at it.

## A landed pull request reads CLOSED, not MERGED

The train squashes each branch onto a release branch and merges ONE pull request, so every
passenger is closed by its `Closes #n` keyword rather than merged. GitHub therefore shows
`state: CLOSED` with an empty `mergedAt` for work that shipped perfectly.

Do not read that as "the fix never landed". On 2026-08-30 site#717 looked abandoned by that
signal while its change - the store tile with no tagline and the name at 64px - was sitting on
master the whole time. **Check the code on master, not the pull request's state.**

## Rework what a train stranded, before running the next one

A train drops at most one of any set of branches that touch the same file, lands it, and leaves
the rest stranded. The next train then drops them again - against a master that has moved further
away, so the conflict is bigger each time.

**Run `rework.js` on the stranded list as soon as a train finishes, before the next train.**
Otherwise the queue accumulates branches that can never land, and each round makes them harder.

That does not mean the lander must idle while a rework runs. What makes a rework re-strand is
master moving under the file it conflicted on - so check that first, and if nothing in the queue
touches it, run both at once:

```bash
git diff --name-only origin/master...origin/<queued branch> | grep -E '<the conflicting file>'
```

On 2026-08-30 #770 was stranded on `db/schema.rb` alone while four clean pull requests waited.
None of them touched schema.rb, db/migrate or Gemfile.lock, so the train and the rework ran
together and neither disturbed the other. Serialising them would have idled the lander for a
quarter of an hour to avoid a conflict that could not happen.

`stranded.sh` computes that list from git rather than from memory - every open `devloop/` pull
request whose branch no longer merges, with its conflicting files and whether it still carries the
label. Run it after every train. It exits 1 when something is stranded, so it can gate a loop.

It reads unlabelled pull requests too, on purpose. `rework.js` strips `lane-verified` while it
works, so a rework that dies leaves a branch that is stranded AND unlabelled - invisible to the
train, which reads the label, and invisible to any check that reads only labelled ones. The first
run of this script found extension#123 sitting in exactly that state, superseded and forgotten.

It uses the WORKTREE to tell a dead lane from a working one, because an unlabelled pull request
means both. A build lane pushes before it hands off, so between its first push and its label its
pull request looks exactly like an abandoned one - #771 was reported stranded while its lane was
still building it. A lane removes its own worktree at handoff, so a worktree that still exists
means somebody still holds that branch. Those are listed separately, do not set the exit code,
and must be left alone: reworking a branch a lane is still writing to is how you lose its work.

This bites hardest on families of tickets that append to the same registry. The tool pages
(`app-rvce.*`) are the worst case on this project: every one adds an action to
`app/controllers/tools_controller.rb`, a line to `app/models/tools/catalog.rb`, and a copy block
to all seven files under `config/locales/`. Any two tool-page branches conflict by construction,
so a train can carry exactly one. On 2026-08-30 four ran concurrently; #762 landed, #763 was
dropped with nine conflicts, and #739 was dropped twice before turning out to be a duplicate of
#762 built from a second ticket.

None of those conflicts need judgement - they are all "master added an entry, this branch added a
different one", and the resolution is always to keep both.

`db/schema.rb` is the other guaranteed one, and it is not resolved by keeping both. **Every branch
carrying a migration conflicts with every other branch carrying a migration, on that single
file.** #770 was dropped for it and nothing else. schema.rb is generated: the resolution is to
take master's copy wholesale and re-run the migrations so Rails rewrites it, never to merge the
conflict markers. `rework.js` says this; the point of repeating it here is that a schema.rb
conflict looks trivial and invites a hand-merge, and a hand-merged schema whose version line is
lower than a migration that exists is how a deploy silently skips one. `Gemfile.lock` is the same
shape - take master's, re-run `bundle install`.

This is left for rework rather than taught to the train on purpose. Auto-resolving schema.rb in
the lander would mean running migrations inside the train, which puts a database dependency into
the one step that currently needs none.

## A pull request the train dropped

A train that meets a file-level conflict DROPS that branch and carries on. The branch is not
rejected and nothing about its work is wrong - it has fallen behind master. Nothing re-queues it,
so it is dropped by every later train too, silently, until somebody merges master into it.

Do NOT send it back through `task.js`. That script builds features, and its triage gate correctly
refuses a pull request whose work is already done and already green - it bounces with
`needs_feedback` saying the job belongs to a rebase process. On 2026-08-30 there was no such
process and site#739 was dropped by two trains in a row for the same two conflicts.

```
# --args reserves the lane and carries root, repos and skillDir, which rework.js refuses to
# run without. Add the pull request and the repo key to what it printed.
args=$(bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/config.sh --args app-st1o.1.2)
script=$(bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/run-script.sh rework.js)

Workflow({ scriptPath: <script>,
           args: { ...<the object config.sh printed>, pr: 739, repo: "site" } })
```

Two agents, no design and no review: merge master in keeping BOTH sides of every conflict, push
without force, wait for CI on the new head, re-apply `lane-verified`. It takes a lane the same way
`task.js` does, so give it a free slot, and it gives the lane back the same way - in a `finally`, so
a `red`, a `blocked` and an exception all go through it rather than only the handoff. It strips the label while it works, because a
`lane-verified` branch that cannot merge is a lie the lander keeps acting on.

Find the dropped ones in the train's own result - `stranded` - or on the pull requests, which each
get a comment saying they were dropped rather than rejected.

## The loop

Each tick, about a minute apart:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/devloop/queue.sh          # print the state - always, so the user sees it
```

Then, from the numbers it printed:

- `running now` is read off the tracker: one workflow owns one issue and holds it
  `in_progress`, so that count IS the number in flight. It needs no task list and survives
  a session restart.
- If `running now` >= 5, do nothing this tick but print the summary.
- If fewer, claim and dispatch the shortfall:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/devloop/queue.sh --next 2   # claims 2, prints "<id> <slot>" a line
```

**A dispatch that returns `error`.** The script cannot run `bd`, so a workflow that bails
before its first agent - bad args, missing id - leaves the issue claimed and does nothing
for it. Unattended, that drains the queue into permanent claims within a few ticks. So after
launching, if a workflow returns an `error` result, release its issue yourself:

```bash
bd update <id> -s open
```

`args` must be an actual JSON object in the tool call, not a JSON-encoded string. The script
now coerces a string rather than no-opping, but the object form is what to write.

`--next` sets each issue to `in_progress` **as it hands the id back**, so two ticks - or two
supervisors - cannot dispatch the same issue. It prints one `<id> <slot>` pair per line.
Launch one `task.js` workflow per line, passing **exactly the slot it was given** -
`{ id: "app-xxxx", slot: 3 }` - all in the background. Never dispatch an id `--next` did not
give you, and never choose a slot yourself.

The slot is not decoration: `task.js` derives `TEST_ENV_NUMBER` from it, so the slot number
*is* the test database. Two live workflows on one slot share a database and corrupt each
other's run. `--next` now assigns it from a registry under `/tmp/<lockPrefix>-slots`, reconciled
against `in_progress` on every call, so a slot frees itself as soon as its issue is released
and a died workflow needs no cleaning up by hand.

- If `ready to start` is 0, stop looping and tell the user what is waiting on them. Spinning
  on an empty queue is not monitoring.
- Report at each tick: what shipped since the last one, what moved to `waiting on you`, and
  anything flagged STALE.

Between ticks, schedule rather than block:

```
ScheduleWakeup({ delaySeconds: 60, prompt: "<the original loop request>",
                 reason: "devloop tick: check running count and top up to 5" })
```

A minute is the floor the runtime allows. Workflows also notify on completion, so a tick
often happens sooner than the wakeup - that is fine, the claim in the tracker keeps it
honest.

## What one issue goes through

1. **Triage** - reads the issue and decides the repo, whether it is user-facing, and whether
   it is safe unattended. Ineligible stops here: the reason is written onto the issue,
   `needs-feedback` is added, and the workflow returns without touching code.
2. **Split** - when the *only* thing wrong is shape - the issue spans repos, or bundles
   independent fixes, or is half-verifiable here - it becomes several issues instead of a
   question. Deciding an issue is two issues is scoping, not a product decision. Children
   are created under the parent, the parent becomes an epic so it stops being picked up, and
   the loop takes the children on its next tick. A child that still needs a person is
   created too, labelled `needs-feedback`, rather than being dropped.
   Splitting may not invent scope, drop a requirement, or pick between fixes the parent
   proposed - if the parent leans towards both, both become children. Size alone is never a
   reason to split; independence is. If a child would still be ambiguous, it asks instead.
3. **Design** - if the issue changes anything a user sees, a `page-designer` agent decides
   the appearance first and hands the implementer a brief. An implementer that discovers
   mid-way that its change is user-facing returns `needs_design`, and the design happens
   then, without spending an attempt.
4. **Fix** - its own worktree off `origin/master`, its own branch, tests and lint green,
   PR opened. For a UI change it must also capture before/after screenshots.
5. **Review** - an independent agent tries to refute the fix: reverts the change to prove
   the test fails, hunts for regressions the suite cannot see, and **for a UI change opens
   the screenshots and looks at them**. It cannot approve a UI change it could not see.
6. **Loop** - rejection sends the reviewer's blocking list back to the implementer, same
   branch, same PR. Three rounds maximum.
7. **Ship** - three checks, not one. The PR's own checks green; **master green right now**;
   and the branch **current with master**. A green tick on a PR is historical - it proves the
   branch passed against a base that may no longer exist, and `MERGEABLE` from gh only means
   no textual conflict. Two changes can agree line by line and contradict in meaning.
   If the branch is behind: rebase, push, wait for CI again.
   If the rebased branch is **red**, that is `needs_rework` - back to Fix with the failures
   and a **fresh review budget**, because master moved rather than the implementer failing.
   Capped at `maxReworks` (2) cycles, then it goes to a person.
   Commit messages and PR body are read back before merging and the squash message after.
   The worktree is removed **before** merging, or `--delete-branch` fails on every issue.
   After merging: pull master, wait for its run, and if master went red say so first and do
   not deploy.
8. **Close** - only once merged and deployed. A merge that is not live leaves the issue open
   with a note.

## What a run costs

Measured on site, which is the slow one:

| step | time |
|---|---|
| Triage | 1-2 min |
| Design (only when there is something to design) | 2-3 min |
| Fix, one round | **15-20 min** |
| Review, one round | 5-7 min |
| Ship (CI wait, merge, staging deploy) | 5-8 min |

So a clean first-round site fix is around 30 minutes, and a third round pushes past an hour.
Most of a fix round is the suite: 2m20s a run, and an agent that runs it after every edit
spends its life waiting - which is why the fix prompt says to iterate on the targeted file
and keep the full suite for the end.

This changes what is worth sending through it. A chore, a small defect with an obvious shape,
anything on extension or integration (seconds, not minutes, to test) - good. A P0 with subtle
semantics is not cheaper here than doing it yourself; what you buy is the adversarial review,
not the speed. Judge a long-running task by which round it is on, not by the clock:
`/workflows` shows the phase, and a second Fix round means the reviewer found something.

## Where it stops and asks

Any of these puts `needs-feedback` on the issue, writes the question and the options into it,
and leaves the branch and PR alone:

- the issue offers a choice that changes what ships, and splitting would not resolve it
- billing, payments, Stripe, pricing - money is never moved unattended
- anything deciding who gets in or what they may do: passwords, sessions and tokens, 2FA,
  OAuth, confirmation and reset flows, credential issuance or storage, roles and policies,
  or which attributes a sign-up will trust. The auth *screens* are not excluded - a checkbox
  on the sign-up form or wording on a reset page is ordinary work. The test is what the
  change decides, not which folder it sits in
- destructive migrations
- it cannot be verified from a terminal here - a device, an installed PWA, a store
  submission, a production observation
- the real fix is much larger than the issue implies
- tests will not go green without weakening an assertion
- three review rounds did not converge

A question written onto the issue is a success. A guess merged unattended is not.

## A bug in the loop is not a ticket in your backlog

**Problems with this tooling go to <https://github.com/404sl/pitwall/issues>, not to the
tracker you are working.** That includes anything in this skill or its scripts: a lane that
dies the same way twice, a check that passes on evidence it never read, a command that
recommends something destructive, output that says one thing and means another.

Two reasons, and the second is the one that bites.

**A local ticket would be picked up by this loop.** Anything filed in the workspace tracker
becomes dispatchable work, so a lane would claim it and try to fix the loop while running
inside it. The plugin is installed in a versioned directory that a lane has no business
editing - a fix there survives until the next `/plugin update` and is invisible to everybody
else. So the loop would consume a lane, produce a diff nobody can merge, and quietly diverge
the tool from the version it reports.

**The evidence is worth more than the fix.** Most of the unusual code here exists because
something failed once in a way nobody predicted, and the comment recording that is what stops
it being rewritten back. A report that says what ran, what it printed and what was actually
true is more useful than a patch, because the patch is the easy half.

Include the version - `/plugin` lists it - and what the loop printed at the point it went
wrong, verbatim. "It got confused" is not reproducible; a lane's own output is.

**A bug in the software you are working on is a different thing**, and belongs in your
tracker as normal. The test is whether the fix would live in your repositories or in this
plugin.

## Deploy behaviour

- **site** - `mina staging deploy`, never production. mina ships `origin/master`, so it
  deploys exactly what was merged.
- **extension** - rebuilds so it can be reloaded in Chrome. If the main checkout is on
  master and clean it builds there; otherwise it builds merged master in a worktree and
  copies `dist/` into the main checkout without switching branches or touching uncommitted
  work. It reports the sha `dist` now contains.
- **integration** - rebuilds and checks `dist/` is in step. Never publishes: releasing is
  manual and protected by a one-time code.
- **docs** - articles, design references and marketing material. It has no remote and no CI,
  so there is no PR to open and no checks to wait for. It still branches and still goes
  through review; only the pull request is skipped, and the branch is merged into master
  locally with `--no-ff` so the history shows what landed. The result says plainly that the
  change exists on this machine and nowhere else.

## What it prints while it runs

Every task announces itself when it starts and again the moment it lands, whatever it landed
as, as a narrator line above the progress tree - so a lane that stopped shipping never looks
like a lane that is still thinking:

```
lane 2 starting app-1056 (P0, site) - A NUL byte anywhere in the HAR loses the recording attachment
SHIPPED app-1056 P0 site - A NUL byte anywhere in the HAR loses the recording attachment
    https://github.com/your-org/your-app/pull/74
    2 rounds
    staging release 20260818154701
NEEDS YOU app-7c9b P1 site - Admin creating a subscription type still makes a junk plan in Stripe
    asks: Drop create_in_stripe entirely, or make it honour periodicity and currency?...
MERGED? NO app-1056 P0 site - ...
    CI red: test job failed on i18n_spec, missing pt key
```

Outcomes are `SHIPPED`, `NEEDS YOU`, `SPLIT`, `NOTHING TO DO`, `BLOCKED`, `MERGED? NO`,
`AGENT DIED`. A `SPLIT` returns no work done on purpose - its children appear in the queue
on the next tick, so the loop makes progress on the following pass rather than this one.
Designs and rejected review rounds print as they happen too.

These lines go to the person watching, live. They do **not** reach the agent that launched
the workflow - it sees only the final return value, when the pool drains. So if you want to
be told about a `NEEDS YOU` before the whole run finishes, watch `/workflows`; the launching
agent cannot relay what it has not been shown.

## Before trusting a run

- `bd list --status open --label needs-feedback` - the queue for a person
- `git worktree list` in each repo - lanes clean up after themselves, leftovers mean a
  handover or a crash
- issues left `in_progress` are claims from a lane that died; reset them to `open`

## Notes that will bite

- Migrations must be generated with `bin/rails generate migration`, never named by hand.
  Hand-picked versions come out on the hour and two agents in the same hour collide, which
  raises `DuplicateMigrationVersionError` on boot and is invisible to git - two files with
  different names have no textual conflict. It has already happened once.
- `bd update --notes` **replaces** the notes; `--append-notes` adds to them. bd's help calls
  the destructive one "Additional notes", which is how a recorded decision and a workflow's
  own diagnosis both got wiped before anyone noticed. Always append.

- The tracker is at the working-folder root and is **not** version controlled. It is also
  the lock: dispatch only through `queue.sh --next`, which claims as it hands out.
- A workflow that dies leaves its issue `in_progress` forever. `queue.sh` flags a claim
  older than an hour as STALE with the command to release it. Nothing releases it
  automatically, because an issue genuinely being worked on looks identical.
- Keep decision-bound issues out of the queue by labelling them `needs-feedback` up front.
  Triage would catch them anyway, but that costs a workflow to learn what a label says.
- Visual evidence is scaffolding and must never reach a commit. Captures are written by a
  throwaway spec that is deleted before committing, and both the implementer and the
  reviewer grep the staged diff for the worktree root, the scratch root and `save_screenshot`. A scratch
  path baked into a permanent spec makes every future run of that suite, on every machine,
  write into a directory that exists on one of them.
- **There is no pre-commit hook, and lanes must not pass `--no-verify`.** This line used to
  say site's hook ran `bd sync --flush-only`, failed in a worktree, and should be bypassed.
  That was true until 2026-08-18 and has not been true since: `site/.git/hooks` holds nothing
  but samples, `core.hooksPath` is unset in both local and global config, and no hook in any
  of the four repos mentions bd. Checked, not assumed. Lanes went on bypassing a hook that
  was not there for five days, copying the workaround out of each other's closed issues and
  reporting it as friction worth flagging - `app-1mat` was raised on the strength of about
  thirty such notes. `--no-verify` disables EVERY hook rather than the one somebody had in
  mind, so the habit would silently skip a secret scan or a linter the day one is added.
  Commit normally; if a hook ever does reject a commit, report what it said and stop rather
  than going around it. Do not let a lane run `bd init` in a worktree - it creates a second
  database that flushes unrelated edits into a repo.
- Site lanes need `TEST_ENV_NUMBER` to keep their test databases apart; the script assigns
  one per lane. Adding lanes beyond 5 is fine, but nothing else may run the suite meanwhile.
- A fresh site worktree needs `.env`, `config/master.key`, `node_modules` and
  `app/assets/builds` symlinked in to boot. All gitignored; they must never reach a commit.

## Check bd's exit code per command, not per call

`bd update <id> --label X` DOES NOT EXIST. The flag is `--add-label` (or `--set-labels`,
which replaces). The wrong one exits with `unknown flag` and changes nothing.

That is harmless on its own. What made it dangerous on 2026-09-08 was running it in the
same call as an `--append-notes` that SAID the label had been applied. The note
succeeded, the label did not, and the tracker then carried a note asserting a state that
did not exist - which is precisely the failure this pipeline's tracker is meant to
surface, committed into it.

So: one bd write per command, check the exit code of each, and READ BACK anything you
have just claimed in prose. A note describing a change is not evidence the change
happened.

The same applies to `--notes`, which REPLACES the whole field and leaves no history. Use
`--append-notes`, and pass the text through a file or an unexpanded heredoc so the shell
cannot substitute backticks inside it - a note written through a double-quoted string had
its backticked commands EXECUTED and their output saved in place of the text.

## Other sessions exist, and nothing tells you what they did

A supervisor is not the only actor in its workspace. Another session merges a pull
request, files a ticket, answers a decision, publishes a package, fixes the tooling.
Each of those changes what the queue would say - and none of them wakes a loop that is
blocked on its own lanes.

This is not hypothetical and it is not cheap. On 2026-09-08 a pool of three ran ONE lane
against twelve ready issues, with two labelled pull requests waiting to be landed,
because every event that made that work available happened in a different session.

**Ask, at every tick, rather than deciding from what you remember.**

```
bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/whatsnew.sh   # did the tooling change under you?
bash ${CLAUDE_PLUGIN_ROOT}/skills/devloop/watch.sh      # what should be done right now?
```

Both are silent when there is nothing to say, so they are safe to run every time and
carry no cost when the world has not moved. `watch.sh --loop N` emits only on change and
is meant to be attached to a monitor, so a supervisor can be WOKEN rather than poll.

`watch.sh` prints only actionable things: idle lanes with dispatchable work, a labelled
pull request nothing is landing, a stale claim. It is not a dashboard - `queue.sh` is
the dashboard - and if it prints nothing, there is nothing to do.

### Tell the other session. Do not assume the next tick notices.

When you do something that changes what another session can do, MESSAGE IT. The
mechanism is a cross-session message; the discipline is knowing when it is owed.

Owed when you:

- merge or land a pull request another session is waiting on
- file, unpark, answer or re-label an issue that unblocks somebody's work
- publish a package, change a shared dependency, or run an install in a checkout whose
  `node_modules` other worktrees borrow
- change anything under this skill

A message that is owed and not sent shows up later as a lane that did not run, and it is
almost never diagnosed as a missing message.

**Say what changed and what the other session should do about it.** "Merged #6" is a
fact; "merged #6, so pitwall-ea3 is unblocked and can take the next free slot" is a
message. The second one is actionable without the reader reconstructing the first.

**Warn BEFORE, not after, for anything that alters what a running lane compiles
against.** An install rewrites the directory every worktree borrows by symlink, and
content being identical does not make the write atomic from a reader's side - a lane
that fails that way reports it as its own failure and spends a review round on it. Wait
for a window with no live lanes, and let the other session tell you when that is: it can
see its worktrees and you cannot.

### Changing this skill

It is SHARED. Every workspace on this machine runs the version on disk, and sessions
already running loaded the previous one and will never notice on their own.

So: record an entry, and message the live sessions. `whatsnew.sh` covers the ones that
start later and the ones that tick; the message covers the one that is mid-run right now.
Neither substitutes for the other.

Record what a session should DO differently, not what the diff was. A new script nobody
is told to run is a file, not a capability.

**A lane writes the entry in its PULL REQUEST BODY, under a `## Plugin changelog`
heading, and touches none of the three version files** - `.claude-plugin/marketplace.json`,
`plugins/devloop/.claude-plugin/plugin.json`, or the version heading of `CHANGELOG.md`.
`assign-plugin-version.sh` copies that section into `CHANGELOG.md` under the version the
lander assigns at merge time. A lane that picks its own number picks the number every
other lane in the pass picked: the first to land moves master past the rest, and the rest
are refused for a reason that has nothing to do with their content.

A body the lander cannot read at all stops the merge rather than moving the number: a
version whose heading has nothing under it is the entry this whole section exists to
deliver, and the next pass reads the body again.

Editing the skill by hand, outside the pipeline, you write the `CHANGELOG.md` entry and
the version yourself - there is no lander in that path to do it for you.
