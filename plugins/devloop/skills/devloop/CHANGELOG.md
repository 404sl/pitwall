# Changelog

## 0.1.13

**The lander asked its release step to substitute a token, and the release step said it had not
been given one.** The lock survived a run that merged, deployed, closed its issue and reported
success. Nothing landed for 25 minutes behind it, with two pull requests queued, one of which
deploys on merge.

`land.js` already released inside a `finally`, and the journal shows that `finally` ran. The
failure was one step further in, in the prompt. The release step was told to *substitute the
token the lock step reported*, and the token was interpolated into the command directly below
that sentence. The agent read the instruction as a job to do, looked for a token it had been
handed separately, found none, and declined to touch a lock it believed it could not prove it
owned:

    "I cannot safely remove it because I was not provided with a token to verify
     ownership against."

That is correct behaviour on the text it was reading. The step had no schema, so the refusal came
back as prose and was recorded as a completed step; the run returned success with the lock still
held.

Both release prompts now say the token is already in the command and to run it exactly as it
stands, and both name this failure so it is not reworded back. `THE-TOKEN-WAS-NOT-CARRIED` is
gone: a sentinel that guarantees the ownership guard fails is a guaranteed leak in the shape of a
safety check.

**A token that cannot be proved is decided in the script, not in the prompt.** Dropping the
sentinel for a bare empty string would have been worse than the sentinel: that guard matches a
holder file that is missing or empty, and a lock directory exists with no holder file for the
window between another lander's `mkdir` and its `printf`, so the command would have deleted a live
foreign lock - the outcome the prompt itself calls unrecoverable. So `land.js` now branches before
it asks for anything: a run whose lock step reported no token emits no release command at all, logs
the leak and carries it back in its result. A lock left standing is recoverable; one deleted out
from under another live lander is not. Putting that condition in the prompt instead would have
reintroduced this entry's own bug - conditional prose sitting under an instruction to run the
command exactly as it stands.

**A positive instruction beats a negative one here, for the same reason the 0.1.10 filter failed.**
The bug was never a missing value - the lock step reported the token correctly. It was a sentence
that gave the agent a task it could not complete. Removing the task removes the failure.

**`land-train.js` had no trap at all.** It took the lock near the top and released it at the
bottom of the straight-line path, so any throw in between - a build agent dying, the bisect
recursion, a guard tripping after acquisition - left the lock behind. Its body is now wrapped in
`try`/`finally` with the release inside, as `land.js` does it. An exception still propagates; it
no longer takes the lock with it. It branches on a missing token the same way `land.js` does,
rather than interpolating an empty `EXPECTED` and leaving the outcome to be argued out between
two paragraphs of prose in the prompt.

**Why a `finally` and not the shell trap the report asked for.** The lock is taken by a subagent
whose shell exits as soon as the command returns, so a trap there would fire immediately and
release a lock the run is still using. The workflow script's `finally` is the process-lifetime
equivalent. Neither covers a killed runner, and nothing in the script can - that case stays
`lock-check.sh`'s.

**A refusal is now reported rather than swallowed, and a stand-down is not reported as a leak.**
`land.js`'s release step had no schema, so its answer went nowhere. It returns `released`,
`not_mine` or `still_held`, and the run's own result now carries `lock` - because the incident was
a lander reporting success while holding the lock, and a journal line a person reads afterwards is
not what the supervisor consumes.

Those three answers are three different instructions to whoever reads the result, so the field
keeps them apart. `not_mine` means the holder file was somebody else's and nothing was removed:
the prompt calls that a correct outcome, and the result says `not_mine - another run holds it,
leave it alone`. Only `still_held`, a missing status or no answer at all become `LEAKED - clear it
by hand`. Folding `not_mine` into the leak told a supervisor to delete a lock that may be live and
foreign, which is the outcome the rest of this entry exists to prevent. The journal line follows
the same split: on `not_mine` the run cannot name the holder and does not pretend to.

For that distinction to be worth anything the guard has to produce exactly one of the two, so it
is now `if ... then rm -rf ... else echo NOT_MINE; fi` rather than `[ ... ] && rm -rf ... || echo
NOT_MINE`. The `&&`/`||` form also printed NOT_MINE when the guard PASSED and the removal failed -
a leak of this run's own lock, reported as a polite stand-down. And the confirmation that follows
runs only on the removal path: a mismatch used to print NOT_MINE and then STILL_HELD from the
confirmation, so both reporting rules applied at once and the agent picked one.

**The token is still minted by the lock agent, deliberately.** Minting it in the script looks
tidier and is wrong twice over: `Date.now()` and `Math.random()` throw in the workflow runner
because they would break resume, so the script would die on its first line with lint, tests and
CI all green - and a random token would not survive a `resumeFromRunId` even if it ran. A test
now asserts no lander reaches for either global.

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
