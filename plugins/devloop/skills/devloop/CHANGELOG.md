# Changelog

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
