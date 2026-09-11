# Changelog

## 0.1.25

**Every lane and every lander stalled on a home-directory config nobody could read.** On one
machine ~/.gitconfig and ~/.bundle/config are symlinks into a synced folder whose files were not
materialised, and the two failures look nothing alike: git answers "fatal: unknown error occurred
while reading the configuration files", and every bundler-fronted command hangs with no output at
all - 60s of wall clock against 0.067s of user time, so blocked on I/O rather than slow. A hang and
a slow machine are indistinguishable, so a run raises its timeout and waits again. Three separate
runs diagnosed this from scratch in one evening, two suites were killed on timeouts first, and the
lander's version step was answering `version_unreadable` rather than merging blind - correctly, and
with nothing able to merge while it did.

Every brief that hands out a git or bundler command now leads with

    export GIT_CONFIG_GLOBAL=/dev/null BUNDLE_USER_CONFIG=/dev/null && <command>

That reaches the fix, review, handoff and split briefs, the rework's resolve and handoff, the
lander's steps and the train's. The exports are unconditional rather than probed: whether a synced folder has
materialised a file is not something a run controls, so the next eviction would bring the whole
failure back. Gems resolve from the default path without the user config. The credential helper
sits in the system config on the machine this was measured on, so pushes keep working there - but
a workspace set up by `gh auth setup-git` keeps the helper in the global config, and these exports
drop it, so a run whose push asks for a password is told to say so rather than to put the home
config back.

- **Commit identity is passed on the command now, not read from a config.** It is the one thing
  those exports take away, and nothing warns about it. Every brief that writes a commit carries
  `git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1
  --format=%ae origin/master)"` - the author master already carries, so there is no new
  configuration to keep in step and the history gains no second name for the same work. The rebase
  the lander is told to run carries it too: a rebase writes commits. So does the merge the rework's
  resolve step runs - `--no-commit` records no author, but git refuses the merge before it touches a
  file, and the lane reports that as a conflict with master that does not exist.
- **`land-train.sh` and `land-one.sh` pass it themselves,** because they merge, commit and rebase in
  their own shells rather than in a brief. Without it the train drops every candidate: the squash
  merge is refused before the commit is even reached, which the script reports as a conflict, and a
  commit that does get that far is reported as "commit refused" - either way the train comes out
  empty, which reads as "nothing was ready". `land-one.sh` reported a rebase that failed for want of
  an identity as a CONFLICT with master, a branch handed back to a person for a reason that was not
  true.
- **Finishing a stopped rebase needs the identity a second time, and an editor.** A `-c` flag
  covers one invocation and does not carry into `--continue` - which is the command that writes the
  commit for a resolved conflict. The lander's rebase step told a run to resolve a textual conflict
  and stopped there, so the only way to finish was a bare `git rebase --continue`: measured under
  the environment the tests pin, that dies with "no email was given and auto-detection is disabled",
  and the wrapper reports it as a conflict with master that does not exist - the same false symptom
  one command later in the same brief. The exports take `core.editor` away as well, and `--continue`
  opens an editor to reword that commit, so `-c core.editor=true` goes on it too; without that it
  dies on the editor instead, having got the identity right. Step 4 now spells both commands out,
  and says not to take git's own hint to set a `--global` identity, which is the file the exports
  exist to ignore.
- **What git does with no identity depends on the machine, and the kinder answer is the dangerous
  one.** Where it can build one from the account - a gecos name and a hostname with a domain - it
  does not refuse: the commit lands, under a name that belongs to nobody. Where it cannot, the
  command fails outright. The first machine this was measured on did the first and a Linux runner
  did the second, from the same commit, so the tests pin `user.useConfigOnly` on and assert the
  author rather than the exit code.

Eight tests, all of which fail before this change. Four drive the workflow scripts as function
bodies and read the briefs they hand out - the fix brief on the first attempt AND on a rework,
which is the one the setup block does not reach, the review brief, the lander's version and merge
briefs, and both rework briefs. Two run the shell scripts against a throwaway remote with no
identity anywhere git can reach: the train must still commit, under master's own author, and the
rebase must not be reported as a conflict. Two read the sources: the standing block must carry no
backtick, which closes a brief's template literal early and blocks every dispatch, and no commit,
merge, rebase or cherry-pick anywhere in the plugin may take its identity from configuration. That
last audit reads the four briefs as well as the two shell scripts, because a brief is where most of
those commands are written; it matches a git invocation in command position, with or without a
`-C <path>` in front of the verb, which keeps prose that merely names a command out of the result,
and skips `merge-base`, `merge-tree` and the `--abort`/`--skip` forms, none of which write a
commit. `--continue` is NOT skipped, because it is the command that writes the commit for a
resolved conflict - and the lander's rebase step was leading a run straight into a bare one.

## 0.1.23

**A rework gave its lane back only when it handed off.** `rework.js` takes the lane lock in its
first step and the handoff script drops it last, after the label is on - so a pull request that came
back red, a merge that reported `blocked`, and any step that threw all left `/tmp/<prefix>-lane-<n>`
standing. The next run given that slot is refused with `LANE_BUSY` on a lock whose owner has long
since exited. This is the same defect 0.1.21 fixed for `task.js`, in the second script that takes
the same lock on the same terms, and the two endings that leak are ordinary: a rework exists because
a branch fell behind master, and CI coming back red on the new head is a normal answer to that.

- **The lock and its owner file are taken in one command.** The brief used a bare `mkdir` and wrote
  no owner file at all, so an ownership-checked release would have answered `not_mine` for every
  lock a rework ever took. The owner is the issue id, or `pr-<n>` when a rework is dispatched
  against a pull request alone.
- **The release runs in a `finally`,** so `red`, `blocked`, a handoff that answered nothing and an
  exception all reach it. A shell trap is still the wrong level for the reason recorded under
  0.1.21: the lock is taken by a step whose shell exits as soon as the command returns, so a trap
  there fires while the run is still holding it.
- **Both endings that used to return early now set a result instead,** so every ending but an
  exception carries what happened to the lane and the slot. `task.js` has three returns that cannot -
  a return expression is evaluated before a `finally` - and for those the log is the only record; a
  rework now has none.
- **A rework with no slot gives only the lane back.** `--slot` is passed only when the args carry
  one. `config.sh --args` always reserves a slot and emits it as a number, so the case is the
  hand-built args object the dispatch documents - and slot 1, which the script falls back to for
  `TEST_ENV_NUMBER`, is whichever run actually reserved it. Releasing that would be taking a live
  run's reservation.
- **`lane-running.sh` knows the third label.** It decides that a rework journal belongs to another
  issue only when every label in it carries an id, matched against a fixed set of prefixes. A
  `release:` label is new, and left out it would have turned every other issue's rework from
  `NOT-RUNNING` into `UNKNOWN` - which nothing may read as dead, so a supervisor would have waited
  on a lane that was not its own.

The tests drive `rework.js` as a function body with stubbed steps: a red pull request, a blocked
merge, a throwing step and a run with no slot must all reach the release, the release command must
name the lane the brief told the run to claim, and a release that answers nothing is a reported
leak. A source test now reads both scripts and fails on a brief that takes a lane lock without
recording who holds it. All nine fail before this change.

## 0.1.22

**A branch could walk the published plugin version backwards, and nothing between a green build and
a merge looked at the number.** The guard now runs in the two landers, at the moment each merge is
about to happen, and it reads `origin/master` fresh rather than trusting anything carried from
earlier in the run.

A check at push time cannot be correct here however carefully it is written. PR #80 was rebased to
declare 0.1.16 with master at 0.1.15 and was green on node 20 and 22; #89 then landed and took
0.1.16 for itself, so the number #80 had been checked against was stale again and nothing re-checked
it before landing. Master moves after a push, and the only moment the comparison is true is the
moment of the merge.

- **The comparison is scoped to branches that change what the marketplace serves.** A branch whose
  diff against master lists any path under `plugins/` or `.claude-plugin/` must declare a version
  strictly greater than master's; a branch that touches none of them is not asked about a number it
  never claimed. Scoping matters more than it looks: of the 26 changes merged before this one, 12
  declared no bump at all and 8 of those touched no plugin file, so an unscoped rule would refuse
  roughly half the queue - including every change confined to `src/`, `ui/` and `test/`. The three
  that did ship plugin content without a bump are exactly what this refuses, and one of them is
  recorded two releases below: WRITING-TICKETS.md reached the marketplace only on the next unrelated
  release, because the release that added it never bumped.
- **An unreadable master refuses, and so does a version that is not three numbers.** A failed fetch,
  a manifest with no `version` field, and a string like `v0.1.22-rc` all stop the merge and say which
  happened. The alternative - treating a number nobody could read as nothing to block on - is the one
  outcome that makes the guard worse than absent, because it looks present and passes everything.
  A repository that carries no `plugins/devloop/.claude-plugin/plugin.json` on master at all is a
  different case and is reported rather than refused: it ships no plugin, so it has no published
  number to walk backwards. That distinction is drawn from `git ls-tree` printing nothing, not from
  `git show` erroring - told to infer it from an error, a careful reader reports "unreadable"
  instead, and since an unreadable verdict is deliberately never un-queued, every repository
  without the plugin would be refused on every run for ever.
- **The agent reads, the script decides.** The step asks for two version strings, whether the diff
  touches plugin files, and which of three states it was in; the comparison and the refusal are in
  `land.js` and `land-train.js`, where a test can drive them. That is why a per-pull-request agent
  call returns after one was removed at 0.1.18 for costing ~50k of context: this one is two
  read-only git commands on haiku at low effort, and it cannot talk itself past the guard because it
  is not the thing holding the verdict.
- **A refusal un-queues the pull request; an unreadable number does not.** `version_not_ahead`
  joins `conflict` and `red_after_rebase` in the retire step: the label comes off, the finding goes
  onto the tracker issue and the issue goes back to open, because nothing in the pipeline bumps a
  number on its own and a label left on buys the same refusal once per run forever.
  `version_unreadable` is deliberately kept queued, alongside `master_red` and `agent_error` - that
  is ignorance rather than a finding, and un-queueing on ignorance loses work silently.
- **The queue state decides HOW a refusal is recorded, never WHETHER the numbers are compared.** The
  version step also reads `labels`, `state` and `isDraft` back from the pull request it is about to
  have merged. This is the one refusal in `land.js` that fires in front of `land-one.sh`, and the
  survey it acts on is up to an hour old: a lane can pull its label back for rework in that window,
  and a branch mid-rework is exactly the one whose number is behind. Un-queueing it would append
  "attempted, not landed" to an issue that lane is holding `in_progress` and reopen it for a second
  lane. So a pull request the step reports as no longer labelled or no longer open is DEFERRED - the
  merge is not delegated, the label is not touched, the tracker is not touched, and it goes back for
  a later round - rather than refused as `version_not_ahead`. What it must not do is fall through to
  `land-one.sh`: that script is the authority on the LABEL and never reads a version, so handing a
  behind number to it is not "let the shell decide this", it is "skip the version check and let the
  shell decide something else". One misreported `labelled`, or a lane that re-labels between the read
  and the shell's own check, would have merged the number this release exists to refuse. A step that
  reports no queue state at all refuses on `version_unreadable` instead, which stops the merge
  without un-queueing anything.
- **Both landers log the versions they did not compare.** A misreported `touchesPlugin` - or a
  misreported `no_manifest` - is what is left to get straight past the guard, now that a queue state
  reported as gone defers the merge instead of skipping the comparison; the skip used to leave
  nothing in the run log, and it now names both numbers and says the diff listed no path under
  `plugins/` or `.claude-plugin/`.
- **A train refused on its version is retired, not left standing.** The same retire step the red path
  uses closes the release pull request and deletes its branch, so a refusal does not leave a branch
  on the remote that reads like open work. The pull requests it carried keep their labels and go back
  to the queue.
- **Twenty-seven tests hold it**, stubbing the agent for both landers: equal, lower, string-ordered
  (`0.1.9` against `0.1.21`), strictly greater, plugin-untouched, unreadable, unparseable, a step
  that answers nothing, a repository with no manifest, two pull requests in one run where the second
  is refused against the version the first just published, and which of the two refusals un-queues.
  Seven more cover the queue state, and three of those exist because a stub proved a behind number
  merging: a label pulled back, a closed pull request, and an uncomparable version with the label
  gone, each with the merge stub answering `merged` - so what is asserted is that nothing landed,
  which is the only form of that assertion a fall-through could not satisfy. One of the three also
  reads the `DEFERRED` line for both numbers and the flag, because a deferral that names neither
  leaves nobody anything to fix. The rest: a label pulled back and a closed pull request against a
  shell that answers exit 7, a step that reported neither flag, and a step that could read neither
  the manifest nor the pull request, which refuses rather than defers because `land-one.sh` checks
  the label and the checks and never a version. Two read the run log, since a skipped comparison
  that says nothing is indistinguishable from one that never happened, and two read the prompt
  itself, because the difference between "no plugin here" and "could not read it" is the one thing a
  stub cannot check.

## 0.1.21

**A lane that ended any way other than by handing off kept its lane lock, and its slot with it.**
Only the success path gave anything back: `lane-handoff.sh` drops the lock last, after the label is
on, so a split, a `needs_feedback`, a `blocked`, a handoff that failed and a crash all left the lock
standing and the slot reserved. The next run given that slot is refused with LANE_BUSY on a lock
whose owner is long gone - on 2026-08-29 `app-vyom` ended as a split and left lane 3 held, and
`app-vyom.1` and `app-vyom.2` were dispatched into it one after the other and returned having done
nothing, about 330k tokens for two lanes that could not start.

The outcomes that leak are the ones the pipeline is designed to produce often. `needs_feedback` is
the correct answer to a ticket that needs a decision and a split is the correct answer to work
spanning two repositories; neither is an error path, so neither reads as something to clean up
after. Five non-handoff endings in one afternoon leaked nothing only because none of them reached
the database: the lock is taken minutes in, so the three that returned inside three minutes died in
front of it.

- **The release is in the script's own `finally`, which is every exit path there is.** A shell trap
  was considered and is the wrong level for the same reason it was the wrong level for the merge
  lock: the lock is taken by an agent whose shell exits as soon as the command returns, so a trap
  there fires at once and releases a lock the run is still holding. The process that lives as long
  as the run is the workflow script, and `task.js` now wraps everything from Triage to its own return
  in `try`/`finally`. The body is deliberately left unindented - re-indenting 400 lines would bury
  the change in whitespace - which is how the same fix was shaped for `land-train.js`.
- **Ownership is proved from the owner file, not assumed from the registry.** `release-lane.sh` reads
  the id out of the owner file beside the lock and the id in the slot file, and removes only what
  names this run: a foreign owner, a missing owner file and an id that no lane could have written are
  all left exactly as they were. An unprovable release is a visible leak in the run's result rather
  than a guess, because a lock left standing costs a dispatch and one deleted out from under a live
  lane costs two runs their work. A regular file at the lock path is reported as the fault it is -
  `mkdir` can never succeed against it, so that lane is blocked for good rather than until a run
  finishes.
- **The lock and the owner file are now taken in one command.** They used to be two, with a window
  between them in which the lock existed and named nobody, and the generic brief never wrote one at
  all - so a release that proves ownership from that file would have answered `not_mine` for every
  lock those lanes took. A lock taken without an owner file beside it cannot be proved to be
  anybody's, and the brief says so where it is taken.
- **The slot reservation comes back in the same step.** Nothing released it either, and it is the
  reservation that `config.sh --args` consults before dispatching, so a workspace would have run out
  of lanes after as many non-handoff endings as it has lanes. `slot.sh --gc` stays a suggestion
  rather than becoming automatic: it runs against slots whose runs may still be alive, and it freed
  two live ones that way on 2026-08-24.
- **Nothing drops a lane lock without taking its owner file with it, and the owner file goes first.**
  That file is now the proof of ownership, so a lock dropped while a stale owner naming a finished run
  stays beside it is worse than the leak this fixes: between the drop and the run's own release, a
  second run can take the lane, and a release proving itself against the file left behind would remove
  a live lane's lock. `lane-handoff.sh` dropped the lock and left the file, which was harmless while
  nothing read it; `slot.sh --release` and `kill-lane.sh` did the same. With the file removed first the
  same window reads an empty owner, which is `not_mine`, so nothing is removed. The removal is `rmdir`
  rather than `rm -rf` and the path must be shaped like a lane lock: a lane lock is a bare directory,
  so anything inside it is the fault the `STILL_HELD` branch reports, and a mis-derived path is the one
  mistake here that costs more than a leak.
- **A leak is named in the log whatever way the run ended, and a run past triage carries the lane and
  the slot in its result**, as the landers report the merge lock. `not_mine` and `already_gone` are
  outcomes rather than failures to clean up - a handoff that dropped the lock itself reads
  `already_gone` - and only a missing answer or a lock still standing is reported, naming the path to
  read before anything is removed by hand. The three triage bounces - a dead triage agent, a split, a
  `needs_feedback` that never reached the work loop - build their result object before the `finally`
  runs, and JavaScript evaluates a `return` expression before the `finally`, so the answer cannot be
  attached to it afterwards. Those runs still release, and their leak is in the log; the result field
  is for runs that reach the work loop. Tests pin both halves, because the shipped sentence claimed
  both and only one held.

`slot.sh --release` keeps its behaviour and is now for the case it is actually safe for: a run that
never reported at all. It takes the owner file with the lock like everything else that drops one. `rework.js` takes the same lock on the same terms and releases it only at its own
handoff; that is the same defect in a second script and is filed separately rather than folded in
here.

The tests drive `release-lane.sh` as a real process against temporary lock directories - a matching
owner is removed along with its owner file and its slot, a foreign owner and a missing owner file are
not, an absent lock reads `already_gone` and takes the owner file a handoff left behind with it, an
empty or quote-carrying id removes nothing, and a regular file at the lock path is a fault - and
`task.js` as a function body with a stubbed agent, where a `needs_feedback`, a split, a throw and a
verified handoff must all reach the release step, a split's leak reaches the log, and no script that
drops a lane lock leaves its owner file behind. All nineteen fail before this change: nine drive
`release-lane.sh`, which does not exist before it, one reads every script that drops a lane lock and
names the line, and nine drive `task.js` - eight because nothing there reaches a release step at all,
and one because the briefs take the lock without recording who holds it.

## 0.1.20

**A lander reported `"deployed":"failed"` for a deploy that had succeeded.** The deploy finished,
both environments came up on the merged sha and the change was live on the public page; the agent
whose job was to say so hit a session limit and was killed, and the run rendered its silence as
failure. `deployed = (d && d.status) || 'failed'` cannot tell the two apart, and they are not the
same state: a step that returns an error has told you something, a step that was killed has told
you nothing. Re-running a deploy is not free, and a supervisor reading `failed` has every reason
to do it - which is the obvious response and the wrong one.

The same run's close step died the same way, and it was worse. Four issues whose pull requests
had merged AND deployed were left `in_progress` - pitwall-7b1, pitwall-myo, pitwall-q02.1,
pitwall-q02.2 - and nothing anywhere reported that drift. They were found only because somebody
went looking after noticing the deploy report was wrong. A project whose stated purpose is
telling a person whether the reason an issue stopped is still true had left four finished
tickets claiming to be in progress hours after they shipped.

So the lander now distinguishes `unknown` from `failed`, and where it can, it does not have to
choose between them:

- **A deploy step that reports nothing is answered by the hosts, not by the agent.** The pipeline
  already had this primitive and threw it away at the moment it mattered: `deploy-one.sh` runs the
  deploy and then reads `git_revision` back and compares, precisely so a deploy that claims success
  without the revision changing is caught rather than believed. A new read-back step runs only when
  the deploy step went silent. It is asked for one thing - the revision each host reports, keyed by
  the repository AND the environment whose command produced it - and it is told nothing about what
  that revision ought to be. A repository serving something else everywhere is `failed`; one of
  several repositories serving something else is `partial`, and so is a repository confirmed in one
  environment and serving something else in another; an environment that did not answer is
  `unknown`, because silence from a host is not an answer from it either. A deploy that reported its
  own failure is NOT read back - that one told us something, and `deploy-one.sh` had already asked
  the server before saying it.
- **The read-back is not told the answer it is being asked to produce, and does not decide.** Its
  brief carries no sha, no merge list and no description of what a deployed host would be serving,
  and its schema has no status for 'live': it reports what it read, or that it could not read. The
  live-or-not judgement is made afterwards in code, against each deploying repository's own LAST
  merge sha, compared as a prefix of at least seven hex characters. A step handed the value its
  caller will compare against can satisfy its brief by quoting that value back without reading
  anything, and with an unattended `bd close` behind the reply that is the same shape of error as
  the one this release is about. Against the LAST sha rather than the set of them, because a run
  deploys every few merges as well as at the end: a host left serving the mid-run deploy is serving
  a revision genuinely on the default branch and genuinely live, and still missing the merge after
  it. A missing, empty or unparseable revision, or one reported against a repository that did not
  land, is `unknown` rather than `failed` - nothing read is not the same as something wrong.
  **This applies to the silent path only.** A deploy step that DOES report `deployed` is still
  promoted on its own word, with no comparison against what merged, even though it hands back the
  same revisions - pitwall-azp, beside pitwall-80o. Deploys are not verified in code generally yet.
- **EVERY environment a repository deploys to must report that repository's last merge sha before
  it is treated as deployed, and an environment that did not report is unconfirmed rather than
  absent.** This is the decision the reviews kept finding made silently inside a schema change, so
  it is written here rather than only in code: ONE environment's matching revision does NOT confirm
  a repository configured with two, for the purpose of closing tracker issues unattended. A change
  live in staging and not in production is live in neither as far as a tester is concerned, and
  closing its issue says it shipped. The number of environments to require is the length of that
  repository's `deploy` array, which the lander is already handed; the alternative considered and
  rejected was refusing to promote any multi-environment repository from a read-back at all, which
  would report `unknown` on every successful deploy of the only repository here that deploys.
- **Observations are keyed by `{repository, environment}`, never by the repository alone.** Keyed by
  repository, two entries for one repository resolved last-write-wins: the same two observations in
  the reverse order gave the opposite verdict, and one of those orders closes tracker issues while a
  host is serving something stale. Two entries for one pair that disagree are now read as no answer
  for that pair, which is the same rule this release applies to every other contradiction.
- **A read-back is not spawned where there is nothing to read, and reads only repositories that
  deploy.** Where a landed repository deploys but records no `verify` command, or records fewer
  commands than it has environments, no environment set can be confirmed however the step replies -
  so no step is spawned, the deploy stays `unknown`, the issues stay open until a person reads a
  host, and the log names the shape to configure (`repos.<name>.verify` as one command per
  environment, keyed by environment name) because that config lives in the root repository. A
  repository with a `verify` and no `deploy` is not read back at all: it has no deploy behind its
  host, and its non-answer used to drag a whole run to `unknown` while every deploying host matched.
- **An unknown deploy says what a person should check** rather than what happened: the verify
  command for each environment, the sha each repository merged, and the issues left open until
  somebody settles it. It says in the same breath that it is not a failure and must not be
  re-deployed on the strength of the line.
- **The close step has a schema and its answer is read.** It reports the ids it actually closed,
  and anything merged-and-deployed that it did not name comes back in the result as `unclosed`
  and is logged loudly. A killed close step now reports the drift it caused. The loud line fires
  on `unclosed` alone: a pull request that named no tracker issue is a designed state the close
  brief has a block for, and a red line about zero issues is a false alarm on a board whose rule
  is that red means a lane needs a person.
- Where nothing that landed is in a repository with a deploy configured, a silent deploy step
  settles as `not_needed` from the config rather than costing a read-back of endpoints that do
  not exist, and the mid-run deploy logs `unknown` instead of `undefined`.
- **The DEPLOY step's own read-back section is unchanged from 0.1.19.** Every `verify` command a
  landed repository records is printed to it as before, whether or not there is one per
  environment, and a repository that records none still gets the instruction to work out what is
  live by whatever means the project offers. Two deltas and no others: the fallback prose names
  `.pitwall.json`, which is the file that exists, and an object-valued `verify` prints each of its
  commands where a single object used to render as one unreadable value. Everything this release
  adds about environment counts lives in the read-back step and the log, not in that brief - the
  deploy step's word is still what promotes a deploy to `deployed` and closes tracker issues
  (pitwall-azp), so tightening the path nothing reported must not loosen the one that is trusted.
  For the same reason no sentence written for a person reading the log reaches any brief: the line
  naming `repos.<name>.verify` is an instruction to edit configuration, and a brief goes to an
  agent with tools and a checkout that the same brief forbids it to touch.

The result object gains `closed` and `unclosed`. `closed` is `null` until the close step has run
and reported: `not_needed` used to mean both "nothing needed closing" and "that step never ran",
which reads to anything downstream as the first, and conflating those two is what this release is
about. `deployed` can now be `unknown`, which no consumer treats as failure - and nothing may
render it as one.

## 0.1.19

**Two lander runs half an hour apart reported the same merge-lock token, and nothing noticed.**
The token carries the epoch second it was minted, so the pair is self-refuting: a run that
started at 19:44 reported `lander-1788974078-40586`, minted at 19:14 by a run that started
eleven seconds before it. The later run cannot have executed `date +%s` and been given 19:14,
which rules out a same-second, same-pid collision by thirty minutes. Reported as issue #60.

**Why a duplicate token is worse than a duplicate name.** Release-by-token is the ownership
guard everywhere: the removal deletes the lock when the holder file holds the token it was
handed. Two runs carrying one token both pass that check, so the first to finish deletes the
other's lock while it is mid-merge or mid-deploy - and `held_by_other`, which tells a foreign
lander apart by "a token that is not the one you wrote", cannot see the difference either.

**Both landers now decide ownership from the holder file rather than from the answer about it.**
The lock step reports two values - the token it wrote, and what `cat` printed back out of the
holder file, verbatim and untidied - and the run itself requires them to be equal before it
lands anything. They used to be one value, with the step asked to judge the comparison and
report the verdict; the step is now asked only for what it saw, and `holder` is required of it
whichever outcome it reports. A mismatch is treated as somebody else holding the lock: the run
surveys nothing, merges nothing, asks for no removal, and says in its result which two values
disagreed so whoever reads it knows which run to leave alone.

**This is the fix shape the report asked for, and it is deliberately not the other one.** The
issue offered an alternative - mint the token from something unique to the run, in the script -
and that remains impossible here for the reasons recorded under 0.1.13: `Date.now()` and
`Math.random()` throw in the workflow runner, a script has no filesystem access to read the
holder file itself, and no per-run identity is exposed to a script. So the decision that the
token is minted by the lock step stands; what changed is that the run no longer takes the step's
word for what the lock says.

**The comparison ignores the newline `cat` prints, and the removal is handed a trimmed token.**
The holder file is written with `printf` and a trailing newline, so a step doing exactly as it is
told - report what `cat` printed, verbatim and untidied - reports that newline as part of `holder`.
An exact comparison reads a whitespace-only difference as a foreign lander, and the cost of that
is the whole serial pipeline: the lander surveys nothing, merges nothing, leaves standing the lock
directory it created itself, and tells the operator the holder names another lander. Every other
reader of that file already normalises - `release-lock.sh` and `lock-check.sh` through `$(cat)`,
`triage-scan.sh` and `queue.sh` through `.read().strip()` - and both landers now do the same, on
both values. The trimmed token is also what `release-lock.sh` is handed, which refuses a token
carrying a newline rather than releasing anything.

**The train's lock step can now answer the field it is required to report.** `holder` is required
of every outcome the step may report, and the train's HELD branch had no read of the holder file in
it - HELD is ordinary contention, not an edge case. A step asked for a value it was given no way to
obtain either fills in the one field ownership is decided from or burns its retries and answers
nothing. That branch now reads the holder file and reports what it printed, with an empty answer
named as the correct one where the file does not exist yet - which is how a lock looks between
another run's `mkdir` and its `printf`. The train quotes it in the note it stands down with, so a
lock another train legitimately holds no longer reads exactly like one nobody owns.

**What this does not fix, stated plainly, because the report's cause is inferred.** The leading
theory is that an identical `(prompt, opts)` replays a cached result - which is how `resume` is
specified to work, and a lander is resumed by hand after `stopped=merge_refused`. Under a replay
the lock step does not run, so every value it reports is stale together and agrees with itself:
this guard cannot see that, and nothing inside a script can. What it does cover is narrower than
the title of the report and is worth stating exactly: it fires when the holder file disagrees with
what the step says it wrote - either value misreported, or a holder file a person wrote by hand -
because `mkdir` is the mutex and no other lander writes a holder file it did not create. A token
carried over from an earlier run and then written INTO the file reads back identically, so it
agrees with itself and passes, which is the same blind spot as a replay. The guard is sound either
way and it is not the whole of "a lander can hold a token it did not mint". Distinguishing a
replayed acquisition needs per-run entropy reaching the script through `args`, which is a change to
every launch path and is filed as pitwall-lr0.

## 0.1.18

**Updating the plugin did not update what runs, because what runs is a copy and nothing rewrote
it.** The Workflow tool refuses a `scriptPath` outside the working directory, so `task.js`,
`land.js` and `rework.js` are dispatched from `<root>/.autofix-run/` rather than from the install.
Those copies were made by hand, at whatever moment somebody remembered, and nothing compared them
with anything. Measured while fixing this: the `land.js` in force in this workspace differed from
the repository by 128 lines - it matched install 0.1.15 while the repository was at 0.1.17 - so a
two-release-old merge-and-deploy policy was running against a current backlog.

**A merged fix was three states away from being in force, and only two of them were visible
anywhere**: merged in the repository, published and installed, copied into `.autofix-run`. The
last step had a person in it and took between two minutes and an hour depending on when anybody
looked, which made "merged" and "in force" two different states rendered identically.

**`run-script.sh` now stages the workflow scripts, and the dispatch steps call it.** It copies
all four - `task.js`, `land.js`, `rework.js`, `land-train.js` - from the resolved install into
`<root>/.autofix-run/` and prints the absolute path of the one asked for. `config.sh --args` and
`config.sh --land` run it before they print anything and carry the result as `scriptPath`, so the
copy happens on the step a dispatch cannot skip. Staging comes first, ahead of `slot.sh`, because
a failed copy that had already reserved a lane would strand the lane.

**The copy is unconditional: nothing is compared, nothing is version-checked, nothing warns.**
Comparing and refusing still needs somebody to act on the refusal, which is the same failure one
step later; recording a version detects a version change and not a content change, and both halves
of that have already happened here - a release where only one shell script differed, and a release
where the version was deliberately not bumped. There is no stale copy if there is no persistent
copy to go stale, and copying four files costs milliseconds against runs that take minutes.

**Each file is written under a temporary name and renamed into place.** A lander reads its script
at launch, so overwriting it mid-run is safe today - but by accident rather than by design. The
rename means a future runner that re-reads its script cannot see a half-written file.

**Two documented dispatches were already broken and are corrected with it.** The lander example
hand-wrote `args: { preflighted: [...] }` and the rework example `args: { pr, id, repo, slot }`,
neither carrying `skillDir`, which both scripts refuse to run without. Both now build their args
with `config.sh`. `triage-scan.sh` told a supervisor to relaunch the lander at
`~/.claude/skills/devloop/land.js`, a path the tool does not even resolve, and `stranded.sh`
printed `.../rework.js`; both now name the staging step instead.

**A test holds it.** It plants a stale copy, runs `config.sh --args` and `--land`, and asserts the
staged file now matches this install byte for byte and that the printed `scriptPath` is the path
just written. A second test asserts no file in the skill spells out a `scriptPath` of its own: a
path written by hand is the one way left to dispatch something other than what was just staged.

## 0.1.17

**A note in the tracker said nothing about when it was written or by whom, so a superseded one read
exactly like a current one.** pitwall-666 held 17,569 characters in 60 blank-line-separated blocks
and not one timestamp. The first thing anybody met at the top of it was `NEEDS THE ADMIN PANEL, NOT
A LANE` - true when it was written, false a few hours later, and indistinguishable from the newest
line in the field. Two runs read it, correctly obeyed it, and refused a P0.

**`bd-note.sh` now stamps what it writes.** One line above each note carrying an ISO-8601 UTC date
and the writer - `2026-09-10T00:13:11Z devloop-pitwall-326` - where the writer is `$PITWALL_SESSION`,
else `$USER`, else `unknown`. The stamp is added by the helper, not by its callers: callers that
format their own produce a field where stamped and unstamped notes sit side by side and neither can
be trusted. The stamp is preceded by a blank line, so it opens a block of its own in the sense the
console already counts.

**A stamped note is one block only when it is a single paragraph.** Blocks are blank-line separated,
so a multi-paragraph note carries its stamp on the first block and the paragraphs after it follow as
the unstamped blocks they were written as - including the LAST one, which is the block the console
quotes. Nothing downstream may assume the block it holds is stamped, and a multi-paragraph note
therefore shows no date in the quoted slot; its date stays in the history.

**The handoff names its own lane.** `lane-handoff.sh` is the one caller today and it sets
`PITWALL_SESSION` to `lane-<branch>` unless the environment already names the session, so a note
from a lane says which lane rather than which unix account ran it.

**Notes already in the field are not rewritten.** Their dates are not recoverable and an invented
one is worse than none, so an unstamped note stays unstamped and the boundary is visible: above the
first stamp, append order is all there is.

**The read-back still verifies the note, not the stamp.** The token it greps for is taken from the
note as written, before the stamp is attached. Taken afterwards, two notes from one writer in the
same second tokenise identically, and the check would confirm a lost note against the previous
one's stamp - silently reinstating the lost-write bug this script exists to catch. A test holds
that ordering.

**The stamp is metadata in a content field, so every reader of that field had to learn it.** One
definition of what a stamp is lives in `staleness.ts`, and the readers go through it rather than
matching the shape themselves. `noteSaid(block)` returns what a block SAYS and the instant it was
written at, separately; `reasonOf` drops stamp lines from the whole field before the
referenced-issue, pull-request and precondition checks read it; `lastNote` quotes what the block
says. No caller strips for itself and the console defines no pattern of its own - the reason being
that three independent readers were found during this change and each one that forgot produced a
different wrong answer.

**The console reads a note in two places and they want opposite things.** Under the title of an
issue that wants something from you, `LatestNote` quotes the newest block - and a quote that opens
with a machine timestamp is the bug this change exists to fix. It now quotes the prose and prints
the stamp's instant beside it as attribution, in the same format as the staleness `checked at`
two bands down, so the two dates on the page compare at a glance. Where the newest block carries no
stamp the slot renders exactly as it did before: no date, no placeholder. A date not read from that
block is not that block's date. The Notes history keeps rendering the field as written, stamps and
writer names visible, because there the stamps ARE the feature.

**`lane-<branch>` embeds a tracker id, and left in the prose that read as a reference.** A parked
record whose note named nobody came back `resolved` on the evidence `every issue it names has since
closed: pitwall-777`, and with that issue open the board reported a reference as checked that
nothing had checked.

**What counts as a stamp is the whole line, both ends anchored** - an instant, one space, one word,
end of line - and `$PITWALL_SESSION` is collapsed to a single dashed word so a stamp always has that
shape. The first cut of this matched an instant followed by anything, and that was wrong in the
direction that matters: a note quoting its own run log,
`2026-09-09T08:14:02Z gate refused: waiting on pitwall-333 to land the contract field`, lost the line
before the referenced-issue check read it, every id that survived had closed, and a record waiting on
an open issue reported `resolved`. Prose after the instant now keeps the line. **The residual, stated
plainly: a line that is nothing but an instant and one word is still dropped, so if that word is the
only place a note names an open issue, the referenced-issue check does not see it and the record can
read as `resolved` when it is still blocked.** The anchored shape makes that narrow - a pasted log
line almost always says something after its instant - and it does not make it impossible.

**Where a block is nothing but stamp-shaped lines the quote falls back to the block as written, and
the reference scan has no such fallback.** The two are deliberately different. A reader must see
something rather than an empty quote; the reference scan must never be handed a writer token to read
as an issue id, which is how the false `resolved` above was produced. In that fallback no
attribution is printed either - the same instant is not shown twice.

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
