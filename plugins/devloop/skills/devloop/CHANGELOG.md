# Changelog

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
