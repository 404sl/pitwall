# Changelog

## 0.1.16

**The lander resolved a surveyed pull request through a name the survey chose for itself, and
silently merged nothing.** `404sl/pitwall-site#23` was open, green, mergeable and labelled. The
survey rendered its repository as `site`, which in this workspace is the key for the CLI
checkout, so the lander resolved it to `404sl/pitwall#23` - a real pull request, merged the day
before. It found a merged pull request, concluded there was nothing to do, and reported the PR in
no list at all. Twice, on the same one. The same run rendered that repository two ways four
surveys apart.

Nothing was damaged because the collision happened to be already merged. Had it been open and
green the lander would have merged it: the wrong pull request, under the wrong issue, reported as
a success. Every number 1-25 currently exists in both repositories, so the alignment is not rare.

**A repository is identified by its slug now, everywhere the lander keys on one.** The survey
returns `slug` - the `owner/name` it copied from the command it ran - and the configured key is
derived from that rather than read out of the answer. `seen`, the pre-flight intersection and
every log line are keyed on `owner/name#number`, which cannot name two pull requests, and the
survey is told that a number alone identifies nothing. A slug matching no configured repository
is reported as skipped rather than resolved to whatever key it resembles; it used to reach the
merge step, where the lookup threw and took the run down with it.

`preflighted` takes `owner/name#number`. A configured key is still accepted and is rewritten to
that repository's slug, so an existing caller keeps working, and `config.sh --land` normalises
both forms and still refuses a repository it cannot find.

**Every pull request a run surveys now ends up in one of its lists.** A pull request deferred on
every round, or left queued behind a red master, came back in none of them - and a pull request
in no list reads exactly like one nobody labelled. The run reconciles what it surveyed against
what it acted on and reports the difference as skipped, saying which it was, so no future reason
for not acting on a surveyed pull request can be silent by omission.

## 0.1.15

**Nothing answered "is a lane for this id running right now", and four signals answered it
wrongly.** A supervisor tore down a healthy lane 42 minutes into its run on the strength of an
empty `TaskList`; it survived only because it rebuilt its worktree and carried on to a labelled
pull request. A second lane torn down in the same pass was genuinely dead, and neither outcome
was down to the judgement being right.

A slot claim proves a lane STARTED, ever. A lane lock proves it reached the locking phase and
still holds it. A worktree proves a directory exists - a dead lane leaves one behind and a live
lane can be missing one, having had it deleted mid-run. `TaskList` is worse than narrow: it is
unrelated. It lists `TaskCreate` to-do items and has never listed a workflow, so "No tasks
found" is a correct answer to a question nobody asked, and `TaskGet` on a live workflow's own
id answers "Task not found".

`lane-running.sh <issue-id>` answers the actual question and is now what the callers ask. The
harness creates a task output file empty at dispatch and writes it when the run ends, so an
empty one is a run still going; the session transcript carries `taskId` beside `runId`, and
that workflow's journal labels its phases with the issue id. Following that chain attributes
every in-flight task to a lane. `RUNNING` exits 0, `NOT-RUNNING` 1, `UNKNOWN` 2.

**A journal MENTIONING an id is not that lane.** The first version searched journals for the id
anywhere and reported the id as running off the lander's journal, which had merely printed the
worktree path while surveying. Only the `"label":"<phase>:<id>"` entries name a lane's own work.

**And a journal with labels that are not this id is not automatically another issue's lane.**
The scripts do not label alike. `task.js` labels every phase with the issue id, but `rework.js`
labelled its phases `resolve:#<pr>` and `handoff:#<pr>` - the pull request number, never the id
- so a LIVE rework lane read as `NOT-RUNNING`, and `kill-lane.sh` would then have removed the
`<id>-rework` worktree holding the conflict resolution it was writing. A false "dead" is the
one answer this command must never give.

Attribution is therefore keyed on the script the transcript records beside the task id, not on
labels alone: a `task.js` journal whose labels are not this id belongs to another issue; so does
a `rework.js` journal whose every label carries an id and none of them is this one; `land.js` and
`land-train.js` carry no issue id at all and are no issue's lane; anything else in flight is
`UNKNOWN`. Landers are counted separately in the `NOT-RUNNING` line, because attributing them
positively is what lets `slot.sh --gc` free a slot at all - two landers are in flight most of the
day, and treating them as unattributable would have made every verdict `UNKNOWN`.

`rework.js` now labels `resolve:<id>#<pr>` and `handoff:<id>#<pr>`, so its lanes are attributable
in BOTH directions - as this lane when the id matches, and as another issue's lane when it does
not - and the label match accepts the `#<n>` a retried `fix:` or `review:` phase appends.
Attributing only the first direction would have reproduced the fault this release exists to fix,
one step over: a rework runs on the stranded list after every train, so one is in flight
routinely, and calling it unattributable would have made every OTHER id `UNKNOWN` for its whole
duration - `slot.sh --gc` freeing nothing and `kill-lane.sh` refusing every id, with `--force`
the only way past. A guard the operator is taught to force past is not a guard.

One case is left, and it is the transitional one: a rework lane dispatched before this shipped
carries the old id-less `resolve:#<pr>`, which names no issue, so while it is in flight every id
reads `UNKNOWN` - `slot.sh --gc` frees nothing and `kill-lane.sh` refuses for all of them. That
is the safe direction, it ends when that lane ends, and getting past it needs `--force` once a
person has confirmed by hand.

**A lander not being a lane does not make a lane's worktree free.** `land.js` tells the lander to
reuse a worktree that already holds the branch rather than making a second one, so `NOT-RUNNING`
for an id can be true at the same moment as a rebase running inside
`/tmp/<prefix>-worktrees/<id>` - which `kill-lane.sh` then removes with `--force`. Same harm as
the reported bug, reached by a different route. `kill-lane.sh` now reads the worktree itself for
`rebase-merge`, `rebase-apply` or `MERGE_HEAD` before touching it and refuses with exit 7
whatever the verdict said, so the attribution claim is never load-bearing for the removal.

**`UNKNOWN` is never rendered as dead.** It is what the command says when no task directory
exists for the workspace, or when a task in flight cannot be attributed - the caller is told
which tasks those are, and that one of them may be the lane. `kill-lane.sh` refuses on
`RUNNING` and on `UNKNOWN` and takes `--force` once a person has confirmed; `slot.sh --gc`
keeps any slot it cannot prove idle, and its existing guards remain as extra reasons to keep,
never as a reason to free. Bad arguments exit 6 rather than sharing `UNKNOWN`'s exit 2, so a
permanently unfreeable slot cannot be a typo nobody can see.

The per-tick lane reminder in `triage-scan.sh` pointed the supervisor at `TaskList` for what is
still running. It names `lane-running.sh <id>` now - that reminder is the path by which the
false signal reached the supervisor that tore the healthy lane down.

**The supervisor's own land gate could not see a lane either, and it was the last caller still
reading one of the four signals.** `queue-watch.sh` counted `lanes.sh` rows through a pattern
fixed to one project's id prefix - `^[0-9]+ sr-` - which can never match an id this workspace
mints, so the count was zero whatever was running. It announced "ready to land, no lanes
running" three times in one day with three lanes live. That event exists so a train is not
started mid-run, and a train started over a live lane moves master underneath every running
branch - which is how a pull request was left red-after-rebase earlier.

`lane-running.sh --any` answers the same question about the whole workspace - is ANY lane in
flight - and the gate asks that instead. It reads the same scan and never the registry, because
a claim is one of the signals that cannot answer: it is missed at both ends, and a lane
dispatched by hand never reaches it at all. Any in-flight workflow whose journal labels a phase
is a lane, whichever issue it belongs to; a lander is not. When a task in flight cannot be
attributed the answer is `UNKNOWN`, and the gate announces that it cannot tell rather than going
quiet - silence on this line means idle, and it has to keep meaning that.

**A `RUNNING` verdict held that same gate shut and printed nothing, which is the same blindness
one step over.** A task output file is created empty at dispatch and written when the run ends, so
a run that never writes one reads `RUNNING` for as long as the file sits there. Of 20 land runs on
one machine 2 did exactly that, still "in flight" by this scan four hours after recording a
terminal result. Nothing consulted an age, so such a task shuts the READY TO LAND event
permanently and silently, and `triage-scan.sh`'s own LANDER IDLE finding is dropped
unconditionally, so there is no second path by which the supervisor would hear about it.

The verdict does not soften, and that is deliberate: a lane waiting on a CI run writes nothing for
the forty minutes `slot.sh --gc` already allows for, so reading silence as "no lanes running"
would restore the false dead this release exists to remove. Only the silence goes.
`lane-running.sh` now says how long the newest write in the running workflow's own directory has
been silent - its journal and its agent transcripts together, because the journal only moves at
phase boundaries and a healthy fix phase would otherwise read as silent - whenever that is past
`--stale-minutes`, default 20, which is the window `lanes.sh` uses under the same name.
`queue-watch.sh` announces it in the shape of the cannot-tell event above, deduplicated per ready
set and held behind the merge lock, naming the task, the workflow and the silence. The gate stays
shut in every case; what changes is that it no longer stays shut without saying so.

A task whose output file is EMPTY in one scanned directory also no longer counts as in flight when
another scanned directory holds a WRITTEN copy of the same id. Emptiness was judged per file and
the first copy seen won, so a written copy could lose to an empty one.

**`lanes.sh` was answering about whichever workspace the default prefix names.** It built the
registry path from `LOCK_PREFIX` falling back to `devloop` instead of this workspace's
`lockPrefix`, and reported "no slot registry at /tmp/devloop-slots - no lanes have ever been
claimed" while three slots were claimed under the prefix the config names. It resolves the
prefix from the config now and refuses with exit 6 rather than defaulting, the rule `slot.sh`
and `lock-check.sh` already follow: an answer about another project's lanes is worse than none.

## 0.1.14

**A deploy shipped the right code with whatever configuration a shared checkout happened to be
sitting on.** `deploy-one.sh` was handed `--repo-path` pointing at the main checkout and ran the
deploy command there, so `config/deploy.rb` - and everything it loads - came from that working
tree. The CODE is cloned on the server from origin at `:branch`, so the code is always current.
HOST, USER, DOMAIN and BRANCH are read locally, and nothing downstream reads them back. Right
code, wrong configuration, reported as success.

Measured while fixing it: the marketing checkout was on `master`, nothing ahead, FOUR COMMITS
BEHIND origin/master. `config/deploy.rb` was byte-identical across those four, which is why no
deploy had been affected - but `config/app.yml`, which `deploy.rb` loads at parse time through
`app_config`, was nine lines behind. Earlier the same day another checkout was found sitting on a
feature branch with nobody knowing who left it there. Both give the same signature.

**The revision check cannot catch this class, and it is not broken.** It compares the deployed
`git_revision` against the merge sha; the code always comes from origin, so the comparison passes
with certainty while the configuration is stale. It looks at the half that is never wrong.

**So the deploy runs in a worktree cut at `origin/master`, not in the checkout it was pointed at.**
`--repo-path` is now the repository the worktree is cut FROM. The script fetches, resolves
`origin/master`, adds a detached worktree under a `mktemp` directory, runs the deploy with that as
its working directory, and removes both on every exit path through an `EXIT` trap that preserves
the script's own exit code. The shared checkout is never pulled, checked out or stashed: adding and
removing a worktree writes nothing into its working tree, which is why this is a worktree rather
than a pull.

**Cut at `origin/master`, not at local `master`, and a failed fetch is now fatal.** "On the right
branch" and "current" are different properties, and that difference is the whole defect. A fetch
that fails leaves a stale `origin/master` to cut from, which is the same bug wearing the fix's
clothes - it has already produced one by-hand safety check that compared against a ref several
commits old and concluded all clear. The script now refuses rather than deploy from a ref it could
not confirm.

`--expect` still decides the outcome, so a caller that passes the merge sha gets exactly the
comparison it got before. Only the directory the deploy runs in has changed.

**Nothing enforced the documented slot reservation, and a sixth collision found it.** The lane a
run used was chosen by whoever dispatched and passed in as an argument, while reserving it was a
separate step the caller was trusted to remember. Those two can disagree and nothing asks. A
cleanup emptied the registry, every lane dispatched for the following hour ran without a
reservation - two Rails lanes among them completed and merged - and nobody noticed. What
prevented a collision was the lane lock, exactly as `slot.sh`'s own header says: *"THIS FILE IS
BOOKKEEPING, NOT SAFETY."* The pipeline ran on the safety net with the bookkeeping gone, and it
surfaced only because one lane checked its brief against the registry, found its slot empty, and
refused to start rather than falling back to a number that looked free.

**Documentation was not the lever, and the file said so itself.** The rule is in `SKILL.md` in
bold, three lines above the command that would have prevented it, and the same passage already
recorded five earlier collisions from picking numbers by hand - one of them 153k tokens spent
discovering a fact `slot.sh --list` prints instantly. A sixth happened anyway.

**So `config.sh --args` allocates the lane instead of accepting one.** It takes `<issue-id>`,
calls `slot.sh <id>` - which records the reservation and consults the lane lock in one step, and
hands back the same number if the id already holds one - and emits what it got. There is no
number left to choose. Where a lane cannot be reserved, `--args` prints nothing and exits
non-zero: a full pool, a locked lane, a parked issue or a config it cannot resolve stops the
dispatch, which is what a full pool should always have meant.

**A trailing number is still accepted, and is now CHECKED rather than used.** `queue.sh` writes
its registry entry before it prints `<id> <slot>`, so `slot.sh` hands that same number back and
the two-argument form keeps working unchanged. A number that disagrees is refused with both
values named, and the reservation is left standing - releasing it would also drop the lane lock,
which may belong to a run that is still live.

The CLI suite drives `--args` against a throwaway registry: it asserts the reported lane is the
one recorded, that a second dispatch of the same issue gets that lane rather than another, that a
locked lane is never handed out, and that a disagreeing number and a full pool both stop with
nothing on stdout.

## 0.1.13

**The lander leaked the merge lock on the path that runs every time: the one where nothing went
wrong.** Four leaks in one day, and the fourth was a run that landed two pull requests, deployed
both, reported `completed` with a full result and `masterBroken: false` - and kept the lock. The
next lander came back `lockedOutBy` that same token, 59 minutes later, and landed nothing. The
other three paths were a session limit killing a run mid-deploy, a throw on the slug guard between
acquire and release, and an earlier completed run that cost 25 minutes.

**`land.js` already released in a `finally`, and the journal proves the `finally` ran.** The
failure was one step further in, in the prompt. The release step was told to *substitute the token
the lock step reported*, while the token was already interpolated into the command directly below
that sentence. It read the instruction as a job to do, looked for a token it had been handed
separately, found none, and declined to touch a lock it believed it could not prove it owned:

    "I cannot safely remove it because I was not provided with a token to verify
     ownership against."

That is correct behaviour on the text it was reading. The step had no schema, so the refusal came
back as prose and was recorded as a completed step; the run returned success with the lock still
held. Both release prompts now say the token is already in the command, and both name this failure
so it is not reworded back. `THE-TOKEN-WAS-NOT-CARRIED` is gone: a sentinel that guarantees the
ownership guard fails is a guaranteed leak in the shape of a safety check.

**You cannot verify a release by re-reading the lock afterwards.** This is the sentence three
review rounds were spent discovering, and it is why the release is now one script rather than a
command and a confirmation. Release used to be two agent commands with a full agent turn between
them - remove the lock, then look to see whether it is gone. But `lockPrompt` has a queued lander
spinning on `mkdir` every 0.2s precisely so a handoff is not lost, so in that window the waiter
legitimately takes the lock: the second look sees a live foreign lock, reports `STILL_HELD`, and
names a token that is no longer in the holder file. Another lander taking the lock between our
removal and our check is the system working, not a fault - so no check placed after the removal
can tell that apart from a removal that failed, and every mapping built over that gap produces a
confident wrong instruction in one case or another. The worst of them told a person to clear by
hand a lock the next lander was using.

**So `release-lock.sh` does the whole operation in one process.** It takes `--lock` and `--token`,
reads the holder file, removes the lock only if that file holds the token, and prints what it did:
`RELEASED`, `NOT_MINE`, `ALREADY_GONE` or `STILL_HELD`. There is no inter-turn gap to race because
there is no inter-turn. Each lander now emits one command and reports its first word; the prompts
say not to look at the lock again, and a test asserts neither prompt contains a `[ -d`, an `ls -d`,
a `cat` of the holder file or an `rm` of its own.

**A script, not an inline conditional, and that distinction is the whole reason this shape is
allowed.** An earlier round rejected putting the ownership test inside a compound command the agent
is told to run verbatim: a visible `[ -n "$TOKEN" ] && ...` invites the agent to tidy away a test
that looks obviously true, and it leaves the safety condition in text somebody has to read rather
than in code. A script invocation has nothing to tidy - the logic is behind a name, and a lane that
wants to improve `bash release-lock.sh --token X` has nowhere to go.

**Ownership that cannot be proved leaks visibly rather than being resolved by guessing.** A run
whose lock step reported no token emits no removal command at all; so does one whose token does not
match `^[A-Za-z0-9._-]+$`, because that token is interpolated into a single-quoted shell argument
and a quote in it would end the quoting. Dropping the old sentinel for a bare empty string would
have been worse than the sentinel itself: an empty token matches a holder file that is missing or
empty, and a lock directory exists with no holder file for the window between another lander's
`mkdir` and its `printf`. The script refuses both cases itself as well. A lock left standing is
recoverable; one deleted out from under another live lander is not.

**Nothing maps automatically to "clear it by hand" any more.** That instruction asks a person to
perform the one unrecoverable action, so no rule that cannot tell the outcomes apart is allowed to
produce it. `not_mine` and `already_gone` are reported as what they are - outcomes, not failures to
clean up - and the leaked case names the token a person should confirm in the holder file before
touching anything. Both landers carry the result in `lock` rather than only in a log line, because
the reported incident was a lander returning success while still holding the lock and the
supervisor reads the object, not the journal.

**`land-train.js` had no trap at all.** It took the lock near the top and released it at the bottom
of the straight-line path, so any throw in between - a build agent dying, the bisect recursion, a
guard tripping after acquisition - left the lock behind. Its body is now wrapped in `try`/`finally`
with the release inside, as `land.js` does it, and it uses the same script and the same four
outcomes; it used to fold every answer into `released` or `LEAKED - clear it by hand`. An exception
still propagates, it just no longer takes the lock with it. Its `rm -f holder; rmdir` is gone with
the rest of the inline shell, and so is the holder-less window that pair opened.

**Why a `finally` and not the shell trap the report asked for.** The lock is taken by a subagent
whose shell exits as soon as the command returns, so a trap there would fire immediately and
release a lock the run is still using. The workflow script's `finally` is the process-lifetime
equivalent. Neither covers a killed runner, and nothing in the script can - that case stays
`lock-check.sh`'s, and `lock-check.sh` has its own blind spot worth knowing about: a finished run's
directory keeps being written for a while after it reports, so for the first ten minutes a leaked
lock and a live quiet one are indistinguishable by idle time. That is one more argument for making
the lock's lifetime the process's lifetime rather than something a watcher infers afterwards.

**The token is still minted by the lock agent, deliberately.** Minting it in the script looks
tidier and is wrong twice over: `Date.now()` and `Math.random()` throw in the workflow runner
because they would break resume, so the script would die on its first line with lint, tests and CI
all green - and a random token would not survive a `resumeFromRunId` even if it ran. A test now
asserts no lander reaches for either global.

## 0.1.12

**Before parking a ticket for a person, ask whether the answer would differ from any competent
engineer's.** If not, it is not theirs - decide it, record what you chose and why, and carry on.

Ten tickets sat in one owner's queue on 2026-09-10 and none of them needed the owner. Eight
were engineering calls: which of three shapes, whether an old review still binds, where to
dedupe, how a report formats a collision. One was a dependency wearing a park label. One was a
park whose condition had been met hours earlier. The owner found them by browsing, one at a
time, and asked each time why it was theirs.

Also: **a dependency is not a decision.** "After that other ticket lands" is `bd dep add`, not a
park - the tracker holds ordering natively, and a label puts a sequencing fact in a person's
queue where it stops work and waits for an answer nobody owes.

This carries WRITING-TICKETS.md from 0.1.11's tree, which had no bump of its own.


## 0.1.12

**`lane-handoff.sh` reported a tracker note as written when it was not, and exit 0 said so.**
Reported as https://github.com/404sl/pitwall/issues/44 by the lane it happened to: the note was
absent afterwards, the lane found it by reading the field back itself, and appended it by hand.
Three separate holes, all the same shape - the step reported on the attempt rather than the
result.

**A `--note-file` with no `--issue` skipped the whole step in silence.** `--issue` is optional, so
the record block simply never ran and the script printed "handed off". `rework.js` produced
exactly that shape whenever it had no issue id: its template made `--issue` conditional and left
`--note-file` unconditional. The two now travel together, and a note with nowhere to go is a usage
error refused BEFORE anything is labelled, so the repair is to fix the arguments and run it again.
A missing note file is refused there too, rather than warned about after the label is on.

**The read-back could confirm a note that was entirely lost.** It probed with the note's LONGEST
LINE and asked whether that string was in the field. A handoff note's longest line is usually a
pull request link or a heading, and an earlier note on the same issue very often already carries
it - so the check passed on somebody else's text. It now compares the whole note, punctuation
stripped from both sides the way `bd-note.sh` does it. `bd-note.sh`'s 24-character token is
deliberately lenient because it drives a retry loop; this is the verdict, so it is strict.

**An unconfirmed note is no longer a handoff.** It used to warn and exit 0, which reads as success
to anything that checks a status - which is every caller. There is now an exit 5, and it says
plainly that the label IS on, the worktree IS gone and only the note is outstanding, so nobody
re-runs a handoff that cannot help. MISSING and UNREADABLE ask for different repairs and are
reported separately: a note read back and found absent should be appended, while a note that could
not be read back may well have landed, and appending on top of that manufactures the duplicate
`bd-note.sh` exists to avoid. An empty read is not a clean read - the same rule this script already
applies to a pull request body.


## 0.1.11

**A park label is a claim, and it stops everything.** Verify the constraint before writing
needs-access or needs-decision, and put what you checked in the note beside it. Check before
obeying one somebody else wrote, if it can be done in a minute.

A P0 sat parked for hours behind "needs the admin panel, not a lane". It needed a data
migration, and deploy.rb invokes rails:db_data_migrate on every deploy - so a run could have
written it and the deploy would have applied it, with nobody logging in anywhere. One grep
would have shown that. Two runs refused the ticket, correctly obeying the label, and nobody
checked the claim behind it, because a label does not look like a claim. It looks like a fact.

The runs were not wrong and the mechanism was not wrong. The INPUT was wrong, and a label
launders a belief into a fact by being a label rather than prose.

**A park must carry what was checked, or it is a rumour with enforcement.**


## 0.1.10

**The 0.1.3 fix to `lock-check.sh` did not work, and the way it failed is the interesting part.**

It excluded journals whose token lines also said `lockedOutBy`, assuming that is how a blocked
run records the token. It is not. Measured on two real runs, NEITHER journal contained that
string - a blocked run carries the token by another route entirely. So the filter excluded
nothing, both journals passed as candidates, and the ambiguity refusal fired every time two
runs touched a token rather than only when there was real ambiguity. Safe, and not
discriminating.

What separates them is that only the run which TOOK the lock records the acquisition:

    holder   token x1   status "taken" x1
    victim   token x1   status "taken" x0

So it now requires the claim rather than the absence of a disclaimer. **A positive test for
the thing you mean is worth more than a negative filter on one of the ways it might not be
meant** - the filter can be wrong about the format and go on quietly matching everything, which
is what happened.

Verified against the two runs that exposed it: exactly one journal now claims acquisition.


## 0.1.9

**Confirm a defect against the running thing, not the source** - wherever the answer depends on
the cascade, on runtime state, or on how pieces compose. Reading the source tells you what a
rule says; it does not tell you what wins.

A ticket reported a credit at 1.05:1, white on a near-white surface, and the stylesheet agreed.
The rendered page did not: a class selector beat the rule the ticket had read, and the measured
contrast was 18.17:1. Reading the code would have confirmed a bug that does not exist.

**And check the remedy the same way**, because a ticket can be wrong twice. That same ticket
proposed a token which, on those routes, resolves to its light value - 2.98:1, a real failure.
The suggested fix would have introduced the defect the ticket was written to remove. A premise
you have disproved does not make the remedy safe; it makes it unexamined.


## 0.1.8

**Escalate on consequence, not on ambiguity.** A ticket the owner had asked for by name sat
finished-but-unshipped for a day because a run stopped to ask about the heading of one band.
The analysis was right and the recommendation was right; stopping was the error.

Stopping now needs a yes to one of three questions: does it change what the software does;
will anything come to depend on it; and - the one that does the work - can you state which
option you would take AND does anything written support that choice. A preference backed by a
test or a recorded decision is taken. A preference backed by nothing is still worth a
question, because picking there is not applying a rule, it is inventing product behaviour and
attaching a rationale.

The second question exists because reversible-in-code is not reversible-in-fact: an interface,
a documented value or anything on a public surface is depended upon the moment it ships.

Also: **when a brief contradicts a codified invariant, the invariant wins** - a test was
written with evidence, a brief is a sketch made before anyone looked. The run keeps the
invariant, finishes, and must record the divergence loudly enough that the brief gets
corrected. Otherwise the brief stays wrong and the next run stops on the same contradiction.


## 0.1.7

Adds `issues-watch.sh`: new issues on the workspace's repositories, reported once each, silent
otherwise. Meant for a monitor, like `watch.sh`.

It reports and does not decide. Whether an issue becomes work, and whether that work may run
unattended, is a judgement that belongs to a session which can read the thing - a shell script
that triaged would be a shell script guessing.

Two deliberate choices:

- **The high-water mark is the issue number, not a timestamp.** A date filter can be subtly
  wrong and silently report nothing: `created:>` and `created:>=` differ by a day's issues and
  the wrong one returns an empty list that looks exactly like quiet. An issue number only
  increases, so "greater than the last seen" is either right or it fails to fetch.
- **Every issue is labelled with who filed it**, against a configured `trustedIssueAuthors`
  allowlist. Anything not on it is reported as somebody else's report, to be parked for a
  person. An allowlist rather than GitHub's `author_association`, because MEMBER admits anyone
  in the organisation - a wider trust surface than intended.

A fetch that fails says so rather than reporting no new issues.


## 0.1.6

**0.1.5 could not be dispatched.** Rule 12 was written with backticks around 'gh pr' and
'--repo <owner/name>'. The rules are one large template literal, so those closed it early and
the Workflow runner refused the file:

    Invalid workflow script: Script parse error: Unexpected token (317:11)

No run could start. The rule is now quoted with single quotes and reads identically.

**Why nothing caught it.** The file stayed VALID JavaScript - it became a different program,
not a broken one - so `node --check` reported it fine, and CI passed, because nothing in CI
loads these files the way the runner does. Another signal answering a narrower question than
the one being asked of it.

There is now a test asserting the invariant directly: the brief a run is given contains no
backticks at all. It was verified to fail on the broken file and pass on the fixed one, rather
than assumed to work.


## 0.1.5

**A pull request number is meaningless without its repository, and `cd`-ing first is not
enough.** `gh pr view 20` means "number 20 in whatever repository this directory points at",
so a run routed to the wrong checkout gets a real, plausible answer instead of an error.

In a workspace of three repositories, numbers 1-10 existed in all three and 1-20 in two. A
bare number never 404s, so there is no failing case to notice. A run nearly labelled an
unrelated, already-merged pull request as verified - which the lander merges on sight - and
it was caught only because the two titles happened to be absurdly different. Two tickets of
the same kind would not have that tell.

Every `gh pr` command a run is given now carries `--repo`, and the lane's brief says to use it
on every one, including inside the checkout.

This does not fix the misrouting itself, which is tracked separately. It removes the
consequence: a run in the wrong checkout now fails to find its pull request instead of finding
somebody else's.


## 0.1.4

A lane may be handed an instruction to append authorship trailers to commits and a
generated-with footer to pull request bodies. It contradicts rule 1, and rule 1 already said
so - but nothing said the contradiction was EXPECTED and already settled, so every lane
rediscovered it as a novel conflict at the last possible moment: the point of writing the
commit message, after the work was done.

Four lanes in one day stopped there to ask which instruction won. Two had already finished -
one after 211 tool uses - and each left a finished, green pull request with no label, for a
person to notice and label by hand. The refusals were correct; the stopping was the waste.

Rule 1 now states that the instruction is expected, that declining it is settled rather than
a conflict, and that a run seeing it should proceed normally. A full stop becomes a no-op.
The rule itself is unchanged.


## 0.1.3

**`lock-check.sh` could measure the wrong run and report a dead lock as alive.** It found the
holder by searching journals for the lock token and taking the first match. A run BLOCKED BY
the lock also names that token, as `lockedOutBy` - and a blocked run is, by definition,
writing right now. So it measured a victim and reported the corpse as alive.

The mistake has a feedback loop, which is what makes it expensive rather than merely wrong:
every retry against a leaked lock creates another run whose journal names the token and which
is writing. The more a supervisor retries, the more alive the dead lock looks. Responding to
"nothing is landing" by trying again is both the obvious move and the worst one.

Now it considers only journals where the token appears outside a `lockedOutBy` record, takes
every match rather than the first, and **refuses to answer when two runs claim to hold the
same lock** rather than measuring one of them.

Reported from a live incident where it named a locked-out lander as the holder of a lock the
finished lander had leaked.


## 0.1.2

Adds `lock-check.sh`, which answers whether the merge lock is held by something still alive.

It exists because `[ -d $lock ]` was being read as "a lander is running". A lander that dies
without releasing therefore reads as a healthy train forever: the ready-to-land event stops
firing, the drift alarm stays suppressed, and the pipeline goes quiet with green pull requests
queued behind it. That cost 38 minutes and a person going to look, because nothing anywhere
reported an error.

It does not use age, because a legitimate hold can be very long - the lander deploys staging
and production inside the lock, each with a 1500s timeout. It asks instead whether the run that
took the lock is still WRITING, found by attribution rather than by a clock. The pid in the lock
token is deliberately not consulted: it belongs to a shell that has already exited, so `ps -p`
reports a perfectly live lander as gone.


## 0.1.1

**Fixes a regression introduced in 0.1.0.** Removing the hardcoded workspace fallbacks was
right, but `skillDir` had only ever been supplied *by* that fallback - `config.sh --args`
never emitted it. So every lane dispatched the documented way rendered its commands as
`bash undefined/...`.

It degraded silently rather than failing. A lane told to run a script that does not exist
does the steps by hand and the run succeeds, leaving no trace in the outcome. What is lost is
the gate: `lane-handoff.sh` refuses to label a pull request whose checks are empty, failing or
stale, so a lane doing it by hand asserts the label on its own judgement instead. For a Rails
repo `rspec-quiet.sh` is how the suite gets `TEST_ENV_NUMBER`, so without it the run has no
database isolation.

- `config.sh` now derives its own directory and emits `skillDir` from both `--args` and
  `--land`. Derived rather than configured: the install path carries a version segment, so
  anything written down is wrong by the next release.
- The four workflow scripts **refuse** when `skillDir` is absent rather than interpolating
  `undefined`. Silent degradation into a manual path that usually works is worse than a
  failure that stops, because nothing downstream can tell the difference.


## 0.1.0

First published version.

Previously an unpublished skill used across several private workspaces on one machine. This
release is that tool made portable:

- **No workspace defaults.** Every entry point resolved a hardcoded workspace when its
  configuration was absent, which meant a misconfigured run operated on a different project
  entirely - cutting worktrees from it, taking its lane lock, writing into its slot registry -
  while reporting success. They now refuse instead.
- **Harness directories are derived, not named.** The paths used to find live workflow runs
  were one machine's absolute paths, pinned to one project and one session of it. They are now
  computed from the workspace root.
- **Paths inside the skill use `${CLAUDE_PLUGIN_ROOT}`**, so the plugin works from wherever it
  is installed rather than from one directory.
- **Project-specific examples generalised.** The reasoning in the comments is unchanged - it is
  the most valuable thing here - but the tracker ids and hostnames of the project it grew up in
  have been replaced with neutral ones.
