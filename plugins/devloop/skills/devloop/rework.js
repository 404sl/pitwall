export const meta = {
  name: 'devloop-rework',
  description: 'Bring a pull request that the release train dropped back onto current master, and hand it back green',
  phases: [
    { title: 'Resolve', detail: 'rebase the branch onto master, resolve conflicts keeping both sides, push' },
    { title: 'Repair', detail: 'if CI is red on the rebased head, mend what master changed underneath it - once' },
    { title: 'Handoff', detail: 'wait for CI on the new head, then re-label lane-verified' },
  ],
}

// WHY THIS EXISTS AS ITS OWN SCRIPT.
//
// task.js builds features. Its first agent is a triage gate that asks whether the work is
// already done, and for a dropped pull request the honest answer is yes - the feature shipped,
// CI was green, the label went on. So triage bounces it, correctly, and says the job belongs to
// "whatever process handles rebase-and-resolve". On 2026-08-30 there was no such process, and
// site#739 sat through two trains being dropped for the same two conflicts each time.
//
// A drop is not a rejection and it is not a rebuild. Nothing about the branch's own work is
// wrong; it has fallen behind master. Sending that through design, build and adversarial review
// would re-derive a feature that already exists, which is both wasteful and how a good branch
// gets quietly rewritten into a different one.
//
// So: no design, no review. Resolve, then hand back - with one repair in between when the
// rebased head is red, because a branch whose diff is unchanged and whose tests now fail has
// been broken by master, not by its author.

const input = (typeof args === 'string' ? JSON.parse(args) : args) || {}

const ROOT = input.root
const LOCK_PREFIX = input.lockPrefix || 'devloop'
const SKILL_DIR = input.skillDir

// REFUSE RATHER THAN RENDER "undefined". This value is interpolated into shell commands
// the lane is told to run - `bash ${SKILL_DIR}/lane-handoff.sh` and, for a Rails repo,
// `bash ${SKILL_DIR}/rspec-quiet.sh`. Absent, those render as `bash undefined/...`, and a
// lane that cannot find a script does not stop: it does the steps by hand and the run
// SUCCEEDS, leaving no trace in the outcome.
//
// That is why this is fatal rather than a warning. lane-handoff.sh is the gate that refuses
// to label a pull request whose checks are empty, failing or stale; a lane doing it by hand
// asserts the label on its own judgement instead. rspec-quiet.sh is how a Rails lane gets
// TEST_ENV_NUMBER, so without it the suite runs against the shared database.
//
// Silent degradation into a manual path that usually works is worse than a broken one that
// stops, because nothing downstream can tell the difference.
if (!SKILL_DIR) {
  return { status: 'error', notes: 'skillDir was not supplied. config.sh --rework emits it; a hand-built args object must too. Refusing rather than running lanes against `undefined`.' }
}

const WT = input.worktrees || `/tmp/${LOCK_PREFIX}-worktrees`

const REPOS = input.repos

const PR = input.pr
const ID = input.id
const REPO_KEY = input.repo || 'site'
const SLOT = input.slot
if (!Number.isInteger(SLOT) || SLOT < 1) {
  return { status: 'error', notes: `slot was ${JSON.stringify(SLOT)}, which no reservation names. config.sh --rework <id> <pr> <repo> reserves a lane through slot.sh and emits the number it got; a hand-built args object has no reservation, and slot 1 belongs to whichever run actually holds it. Refusing rather than running on a lane this run does not hold.` }
}
const LANE = SLOT + 1 // slot N takes lane N+1; the lane number is also TEST_ENV_NUMBER
const LANE_LOCK = `/tmp/${LOCK_PREFIX}-lane-${LANE}.lock`
const OWNER_FILE = `/tmp/${LOCK_PREFIX}-lane-${LANE}.owner`
const SLOT_FILE = `/tmp/${LOCK_PREFIX}-slots/${SLOT}`
const GIVEN_BACK = new Set(['released', 'already_gone'])

const repo = REPOS[REPO_KEY]
if (!PR) return { error: 'no pull request number given - build the args with config.sh --rework <id> <pr> <repo>' }
if (!repo) return { error: `unknown repo ${REPO_KEY} - expected one of ${Object.keys(REPOS).join(', ')}` }

const SLUG = repo.slug
const REPO_PATH = `${ROOT}/${repo.path}`
const OWNER = ID || `pr-${PR}`
const WT_PATH = `${WT}/${OWNER}-rework`

// A Rails worktree does not boot from a bare checkout: .env, config/master.key and node_modules
// are gitignored, and config/cable.yml dereferences AppConfig at load time, so a missing .env is
// a stack trace that looks nothing like its cause. Stylesheets are built, not committed, so any
// spec reading a computed style fails against a stale build.
const railsSetup = repo.rails
  ? `
This is a Rails worktree and it will NOT boot from a bare checkout. Before running anything:

  cp ${REPO_PATH}/.env ${WT_PATH}/.env
  cp ${REPO_PATH}/config/master.key ${WT_PATH}/config/master.key
  ln -s ${REPO_PATH}/node_modules ${WT_PATH}/node_modules
  cd ${WT_PATH} && TEST_ENV_NUMBER=${LANE} bundle exec rails dartsass:build

Those three files are gitignored, and config/cable.yml reads AppConfig at load time, so a missing
.env raises something that looks nothing like its cause. Stylesheets are generated rather than
committed - any system spec that reads a computed style fails against a stale build, and that
failure also looks like a real bug.

TEST_ENV_NUMBER=${LANE} goes on EVERY command that touches a database, migrations included.
Without it two lanes share one test database and produce failures neither change caused.
`
  : ''

const SHELL_FIRST = `EVERY COMMAND THAT RUNS git OR bundle STARTS WITH THESE TWO EXPORTS, and so does every
command that runs a script which does:

  export GIT_CONFIG_GLOBAL=/dev/null BUNDLE_USER_CONFIG=/dev/null && <your command>

Each command you run is its own shell, so exporting them once at the start reaches nothing after
it - they go at the front of the command, the way TEST_ENV_NUMBER already does. Lead with
'export ... &&' rather than writing them as a prefix assignment: a $(...) inside the command
expands BEFORE a prefix assignment takes effect, so the identity reads below would still go
through the home config.

A HOME-DIRECTORY CONFIG THAT CANNOT BE READ PRESENTS AS ANYTHING BUT ITSELF. Every git command
fails with 'unknown error occurred while reading the configuration files', and every
bundler-fronted command HANGS with no output at all - 60s of wall clock against 0.067s of user
time, so blocked on I/O rather than slow. A hang and a slow machine look identical, so a run pays
its full timeout before suspecting anything: three runs diagnosed this from scratch in one
evening, one of them after killing two suites on timeouts. Whether a synced folder has
materialised a file is not something a run controls, so those files are not read at all. The two
exports cost a readable config nothing and are not conditional.

COMMIT IDENTITY IS THE ONE THING THAT DOES NOT SURVIVE THEM, and every command that WRITES a
commit needs it - commit, rebase, merge, cherry-pick. Pass it on the command, taken from the
branch being built on:

  git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" commit -F <message file>

Without it git either refuses outright, 'unable to auto-detect email address', or writes the
wrong author - and nothing downstream notices the second. On this machine the credential helper
sits in the system config rather than the home one, so pushes keep working - but that is this
machine, not a rule: a workspace set up by 'gh auth setup-git' has the helper in the GLOBAL
config, and these exports drop it. If a push asks for a password, say so rather than putting the
home config back.`

const RESOLVE = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['resolved', 'already_clean', 'blocked'] },
    branch: { type: 'string' },
    oldHead: { type: 'string' },
    newHead: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const LANE_BACK = {
  type: 'object',
  required: ['lane', 'slot'],
  properties: {
    lane: { enum: ['released', 'not_mine', 'already_gone', 'still_held'], description: 'the word release-lane.sh printed after lane:, lowercased - it reports its own outcome and you are not asked to judge it' },
    slot: { enum: ['released', 'not_mine', 'already_gone', 'still_held'], description: 'the word it printed after slot:, lowercased' },
    notes: { type: 'string', description: 'everything it printed, verbatim' },
  },
}

function releaseLanePrompt() {
  return `Give lane ${LANE} and slot ${SLOT} back. Run this command once, exactly as it stands, and
report what it printed:

  bash ${SKILL_DIR}/release-lane.sh --lane ${LANE_LOCK} --slot ${SLOT_FILE} --owner '${OWNER}'

Every value is already in the command. There is nothing to look up, substitute or confirm first,
and nothing for you to judge: the script proves ownership itself - the owner file beside the lock
and the id in the slot file - and removes only what names this run. An earlier release step of
this shape was told to supply a value it had already been given, went looking for it, found none
and declined to touch the lock at all, which left every other lane waiting on it.

Report the word after 'lane:' as 'lane', the word after 'slot:' as 'slot', lowercased, and
everything it printed as 'notes'. Remove nothing by hand, run no other command, and never use
2>&1.`
}

function settle(path, answer) {
  if (GIVEN_BACK.has(answer)) return answer
  if (answer === 'not_mine') return `not_mine - ${path} does not record ${OWNER}, so nothing was removed and nothing should be`
  return `LEAKED - ${path} was not given back, or the release step answered nothing. Read it before removing anything: clear it if it records this run, and leave it alone if it records another.`
}

let laneLock = `LEAKED - the release step never reported. Read ${LANE_LOCK} before touching anything.`
let slotClaim = `LEAKED - the release step never reported. Read ${SLOT_FILE} before touching anything.`
let result = null

try {

phase('Resolve')

const resolved = await agent(
  `Bring pull request #${PR} on ${SLUG} back onto current master. It arrives here one of two ways,
and neither is a rejection - its own work is fine and shipped green:

  DROPPED by the release train for CONFLICTING. The branch is behind master and a rebase stops
  on textual conflicts. Your job is bringing it up to master, and nothing else.

  RETIRED by the lander as RED AFTER REBASE. land-one.sh already rebased the branch onto master
  and PUSHED the rebased head before it waited on CI, so the branch ALREADY SITS ON TOP OF
  MASTER when you get it. The rebase below replays nothing, HEAD after it equals the head you
  record before it, there is nothing to push, and the answer is status 'already_clean' - with
  both heads reported, the same sha. What is wrong with it is SEMANTIC and is not your job: a
  later step in this run repairs it from what CI says. Do not go looking for the break here.

Check which one you have as soon as the worktree below exists, before you touch anything:

  git -C ${WT_PATH} merge-base --is-ancestor origin/master HEAD && echo ON_MASTER || echo BEHIND

ON_MASTER is the second arrival.

DO NOT REDESIGN, REBUILD OR "IMPROVE" ANYTHING ON THIS BRANCH. If you find yourself writing a
feature, you have misread the task. The only edits you make are inside conflict regions.

${SHELL_FIRST}

TAKE THE LANE LOCK FIRST, so you do not share a test database with another lane:

  mkdir ${LANE_LOCK} 2>/dev/null && printf '%s\\n' "${OWNER} slot ${SLOT} TEST_ENV_NUMBER ${LANE}" > ${OWNER_FILE} && echo GOT_LANE || echo LANE_BUSY

ONE COMMAND, not two. The owner file beside the lock is what proves the lock is yours: when this
run ends, whatever way it ends, the lane is given back by reading that file and removing the lock
only if it names this run. A lock taken without it cannot be proved to be anybody's, so it is left
standing and the lane is lost until a person clears it. The file sits BESIDE the lock, never inside
it - anything inside the lock directory makes the rmdir that drops it fail, and then the lane is
blocked for good rather than until a run finishes.

If it prints LANE_BUSY, wait and retry rather than proceeding without it.

DO NOT RELEASE IT YOURSELF. Hold it until the end; the handoff step passes it to
lane-handoff.sh, which drops it last, after the label is on, and this run gives the lane back itself
as it ends whatever way it ends - so there is nothing for you to clean up on any path. An earlier
version of this told you to rmdir it once the suite finished AND passed --lane-lock to the script -
so the lock was already gone by the time the script looked, and the script's rmdir tolerates
absence, which means its exit 0 was not evidence the lock had ever been held. The window between your last
test and the handoff is exactly when another lane can take the same test database.

SET UP:

  cd ${REPO_PATH} && git fetch origin
  branch=$(gh pr view ${PR} --repo ${SLUG} --json headRefName --jq .headRefName)
  git worktree add --detach ${WT_PATH} "origin/$branch"

THE WORKTREE IS DETACHED ON PURPOSE. 'git status' will say 'HEAD detached at origin/...' for the
whole run, and that is correct - do not check the branch out to tidy it. The task lane that built
this branch ended without handing off, so its own worktree very often still has the branch checked
out, and git refuses to check one branch out in two worktrees: an earlier version of this step ran
'git worktree add -B "$branch"' and was refused with 'is already checked out at', and two reworks
were then found improvising, sitting detached beside their lane worktrees. Detached, nothing here
needs the branch name until the push, and the push names it in full.

IF 'git worktree list' SHOWS ANOTHER WORKTREE WITH THE BRANCH CHECKED OUT, that is the task lane's
worktree, and its local ref is the SUPERSEDED head: the one this round is about to replace, or the
one an earlier round already did. Never rebase in it and never push from it. A rebase there replays
the stale head over master, and a push from it under a lease read from the freshly fetched remote
replaces the newer head with the stale one. Leave it alone. The handoff step removes it once the
label is on, and not before.

Record the branch head BEFORE you touch it - you will need to prove it moved:
  git -C ${WT_PATH} rev-parse HEAD
${railsSetup}
TAKE THE LABEL OFF WHILE YOU WORK. lane-verified is the lander's signal that a branch is ready,
and it is currently sitting on a head that cannot merge. Remove it now and let the handoff step
put it back once CI is green on the new head:

  gh pr edit ${PR} --repo ${SLUG} --remove-label lane-verified

A retired pull request has already had it removed by the lander; the command succeeds on a label
that is not there, and its absence is expected rather than a sign something else is going on.

REBASE ONTO MASTER. Do not merge master in.

  cd ${WT_PATH} && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" rebase origin/master

The rebase stops at each commit that conflicts. Resolve inside the conflict regions, stage what
you resolved, and continue:

  cd ${WT_PATH} && git add <the files you resolved>
  cd ${WT_PATH} && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" -c core.editor=true rebase --continue

THE IDENTITY GOES ON '--continue' TOO, not only on the first command. Continuing is what writes
the replayed commit, so without it the rebase stops again with 'unable to auto-detect email
address' and leaves the branch mid-rebase.

AND SO DOES AN EDITOR IT CAN RUN, for the same reason and on the same line. '--continue' opens an
editor on the replayed commit's message, and the exports take core.editor away with the rest of
the home config, so git falls back to vi - which with no terminal prints 'Vim: Error reading
input, exiting...', exits 1 and leaves the branch mid-rebase exactly as a missing identity does.
'-c core.editor=true' accepts the message unchanged. Do not reach for 'git commit' with a message
of your own instead: that REPLACES the message the replayed commit already carries.

REBASE, NOT MERGE, AND THE REASON IS THE LANDER. land-one.sh runs a plain rebase onto
origin/master on whatever branch it is handed, and a rebase replays the branch's OWN commits - a
resolution that exists only inside a merge commit is not one of them, so it is dropped. That is
not theoretical: the pitwall-qku6 branch was merged up to master, master moved, and the lander's
rebase lost a line from a test file and left a version line unmerged. The rebase exited non-zero,
which the lander reads as a branch that cannot land - the issue is retired rather than deferred,
and the work is thrown away. A branch that is already linear replays to nothing and survives that
step untouched.

IF THE BRANCH ALREADY CARRIES A MERGE COMMIT from an earlier round of this shape, the rebase drops
it and the conflicts it resolved come back, one commit at a time. That is expected rather than a
sign something is wrong. Resolve them again; this time the resolutions live inside the replayed
commits, where the lander's rebase cannot lose them.

RESOLVING. Most conflicts here are one shape: master added entries and this branch added
different ones, in the same region. KEEP BOTH SIDES. Taking one side wholesale - --ours, --theirs,
or picking whichever block looks more complete - silently deletes work that is already on master
or already reviewed on this branch, and the suite may well stay green while it does.

"KEEP BOTH" IS ABOUT ADDITIONS, AND IT IS THE WRONG RULE WHEN THE BRANCH DELETED SOMETHING ON
PURPOSE. Before applying it, ask what each side actually did to the region: added, changed, or
removed. A branch that removes an entry must have that removal honoured, or the resolution quietly
undoes the change the branch exists to make - and the suite stays green, because putting an entry
back is not something a test is watching for.

PR #776 on 2026-08-30 was exactly this. Its job was to move a page out of the tools catalog into
the templates one. Master had meanwhile added a different tool. The correct resolution kept
master's ADDITION and honoured the branch's DELETION - not both entries. Keeping both would have
left the page listed in two places and the move half-done.

So: keep every addition from either side, apply every deliberate deletion, and if you cannot tell
which a hunk is, read the branch's own commit messages - they say what it set out to do.

Read both sides of every conflict before you resolve it. For each file, say in your notes what
master contributed and what the branch contributed, so the resolution can be checked by somebody
who was not here.

GENERATED FILES ARE THE EXCEPTION, AND THEY ARE RESOLVED BY REGENERATING - never by editing the
conflict markers. Merging generated output by hand produces a file that is subtly not what its
generator would emit, and the next person to run the generator gets a diff nobody asked for.

  db/schema.rb        take master's version wholesale, then re-run the migrations and let Rails
                      rewrite it:
                        git checkout origin/master -- db/schema.rb
                        TEST_ENV_NUMBER=${LANE} RAILS_ENV=test bundle exec rails db:migrate
                      The version line at the top must end up naming the LATEST migration across
                      both sides. Check that before committing - a schema.rb whose version is
                      lower than a migration file that exists is how a deploy silently skips one.

  Gemfile.lock        do not hand-merge. Take master's, then re-run 'bundle install' so the
                      branch's own gem is re-resolved against it.

  anything under docs/submission or produced by script/marketing
                      images are generated by script/marketing/shots.mjs. Regenerate rather than
                      picking a side; a hand-picked PNG is somebody's stale render.

This is the most common single conflict in this pipeline, because every branch carrying a
migration conflicts with every other branch carrying a migration, on this one file. PR #770 was
dropped by a train on 2026-08-30 for exactly this, and nothing else.

THEN PROVE IT, rather than assuming:

  cd ${REPO_PATH} && git fetch origin && git merge-tree --write-tree origin/master "origin/$branch"

after pushing - it must exit 0, and exit 1 means conflicts remain. While still local, the
equivalent check is that
'git -C ${WT_PATH} status' reports no unmerged paths and 'git -C ${WT_PATH} merge-base --is-ancestor origin/master HEAD'
succeeds.

AND THE BRANCH MUST BE LINEAR. 'git -C ${WT_PATH} rev-list --merges origin/master..HEAD' prints
NOTHING. A line there is a merge commit, and a merge commit is what the lander's rebase drops -
along with every resolution that only exists inside it.

RUN THE TESTS THAT COVER THE CONFLICTED FILES, not the whole suite - the full suite is CI's job
and takes ten minutes locally against about two and a half in CI. If a conflicted file is a spec,
run that spec. If it is a script with its own check, run that check. Say which you ran.
${repo.test ? `  tests:  ${repo.test}` : ''}
${repo.lint ? `  lint:   ${repo.lint}` : ''}

PUSH to the same branch. A rebase rewrites the commits, so a plain push is refused and the push
has to be forced - force it WITH A LEASE, against the head you recorded before you started:

  cd ${WT_PATH} && git push --force-with-lease=refs/heads/<the branch>:<the head you recorded> origin HEAD:refs/heads/<the branch>

BOTH ENDS ARE NAMED IN FULL because HEAD is detached: a bare 'origin HEAD' has no branch to
resolve its destination from and git refuses it as an unqualified destination. The lease is the
whole safety of this step: it refuses if the branch moved after you read it, which is exactly the
case where forcing would destroy somebody else's work. If the lease is refused, STOP and report
status "blocked" with what git said. Never fall back to a plain --force, and never widen the lease
to the bare branch name.

COMMIT MESSAGE RULES. A rebase composes no message of its own: the replayed commits keep the ones
the branch already carried, so there is nothing here for you to write. If a resolution makes one of
those messages wrong and you amend it, it is outward-facing text - say what the code does in the
words a person would use, never mention the pipeline, lanes, labels, trains, worktrees, temporary
paths, or any tooling or assistance, and read it back from git afterwards and check it yourself.

REPORT: status, the branch name, the old head, the new head, and the files you resolved. If the
rebase replays nothing - because the lander already pushed the rebased head before retiring it,
or because something else landed in the meantime - HEAD after the rebase equals the head you
recorded, nothing was pushed, and that is status "already_clean" with oldHead and newHead both
set to that sha and an empty files list. Say so rather than inventing a change, and never call it
"resolved": resolved with a head that did not move is read as a resolution that was never
pushed.`,
  { schema: RESOLVE, phase: 'Resolve', label: ID ? `resolve:${ID}#${PR}` : `resolve:#${PR}` },
)

if (!resolved || resolved.status === 'blocked') {
  result = {
    pr: PR,
    id: ID,
    outcome: 'blocked',
    notes: resolved ? resolved.notes : 'resolve agent returned nothing',
  }
}

// A head that did not move after files were resolved means nothing was pushed, whatever the
// agent believes it did: a resolution that exists only in the worktree is how a pull request
// gets handed back into a train that drops it again for the same reason. A head that did not
// move with NOTHING resolved is the other arrival - the lander already pushed the rebased head
// before retiring it red - and is 'already_clean' whatever word the agent chose.
if (!result && resolved.status === 'resolved' && resolved.oldHead && resolved.newHead && resolved.oldHead === resolved.newHead && (resolved.files || []).length) {
  result = {
    pr: PR,
    id: ID,
    outcome: 'blocked',
    notes: `resolve reported ${resolved.files.length} file(s) resolved but the branch head did not move (${resolved.oldHead}). Nothing was pushed, so the next train would drop this again for the same conflicts.`,
  }
}

if (!result) {

const HANDOFF = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['verified', 'red', 'blocked'] },
    ciConclusion: { type: 'string' },
    mergeable: { type: 'string' },
    failures: { type: 'string', description: 'when red: every failing test, example or compiler error with its message, verbatim from the CI log - the repair step works from this and nothing else' },
    notes: { type: 'string' },
  },
}

const BRANCH = resolved.branch || '<the branch>'

const REPAIR = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['repaired', 'blocked'] },
    head: { type: 'string', description: 'the head you pushed, full sha' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const MAX_REPAIRS = 1
let repairs = 0
let repaired = null
let handed = null

const HAND_BACK = ID
  ? `WRITE IT ON THE TRACKER ISSUE BEFORE YOU REPORT, because the person who takes this over reads
the issue and not this run. Put the text in a file and append it - never --notes, which replaces
the field:

  cd ${ROOT} && export BEADS_DIR=${ROOT}/.beads && PITWALL_SESSION='rework-${OWNER}' bash ${SKILL_DIR}/bd-note.sh ${ID} --note-file <that file>

Say that the branch was rebased onto master and is red on the new head for a reason a rebase
cannot see, name each failure with its file and assertion, say what master changed that it
collides with, and what was tried. Leave the pull request open and unlabelled.

THEN HAND THE ISSUE TO A PERSON, in one command, exactly as written:

  cd ${ROOT} && bd update ${ID} --unset-metadata rework --add-label needs-decision --status open

The rework metadata is what routed this issue here; left on, the next reopen sends it straight
back for a second repair, which is the loop the one-attempt limit exists to prevent. Left
in_progress, the issue is invisible to the queue behind a dead pull request. needs-decision parks
it in a person's queue with the diagnosis you just wrote, and open keeps it visible there.`
  : `Leave the pull request open and unlabelled, and put everything a person needs in 'notes' - there is
no tracker issue for this run to write on.`

function handoffPrompt(head, afterRepair) {
  return `Pull request #${PR} on ${SLUG} has been rebased onto current master and pushed${afterRepair ? ', and a repair step has since pushed a fix for the failures CI found on the rebased head' : ''}. Wait for CI on
the NEW head${head ? ` - ${head} -` : ''} and hand it back to the lander.

${SHELL_FIRST}

  gh pr view ${PR} --repo ${SLUG} --json headRefOid,statusCheckRollup,mergeStateStatus

WAIT for the rollup to be non-empty AND to describe the head that is actually on the branch. An
empty rollup does not mean "no checks yet" - it can also mean GitHub cannot build a merge ref,
which shows up as a mergeStateStatus of DIRTY or CONFLICTING. Check that field before settling in
to wait, or you will wait forever for checks that are never going to be scheduled.

WHEN YOU POLL, A READ THAT FAILED IS NOT A READ THAT SAYS DONE. Treat queued, in_progress,
pending, waiting, requested - and any value you did not expect, including an empty string from a
gh call that errored - as NOT FINISHED. Only an explicit terminal conclusion ends the wait.

This is the difference between a loop that waits and a loop that exits on a network blip and
reports whatever it last saw. A rework on 2026-08-30 had a fallback string its own match pattern
did not cover, so a transient error would have looked exactly like completion; it noticed and
re-checked in the foreground, but the next one might not. Whatever you poll with, make the
unknown case loop rather than fall through, and finish with a direct read of statusCheckRollup
rather than trusting the loop's last value.

IF CI COMES BACK RED, READ THE FAILURES AND REPORT THEM - DO NOT FIX THEM HERE. Report status
"red", do not label it, and put every failing test, example or compiler error WITH ITS MESSAGE
in 'failures', verbatim from the log:

  gh run view <the run id from the rollup> --repo ${SLUG} --log-failed

${afterRepair
    ? `This head already carries one repair. A red result now ends the run and goes to a person, so
'failures' is what they will read: name the file and the assertion for each one, and say whether
it is the same failure the repair was meant to mend or a different one.

${HAND_BACK}`
    : `A step after this one gets exactly that text and a worktree, and works from it: a red head
whose diff is unchanged means master moved under the branch rather than the branch being wrong,
and the failure names the file and the symbol. A failure in a file that was resolved in a
conflict is very likely the resolution having dropped one side - say so in 'failures' so the
repair looks at both sides again rather than at the test.`}

WHEN IT IS GREEN, hand off with the script rather than by hand:

  bash ${SKILL_DIR}/lane-handoff.sh --repo-path ${REPO_PATH} --slug ${SLUG} \\
    --pr ${PR} --branch ${BRANCH} \\
    ${ID ? `--issue ${ID} --note-file <a file holding your tracker note>` : ''} \\
    --worktree ${WT_PATH} \\
    --lane-lock ${LANE_LOCK}

It reads the title, body and commit messages back from GitHub, runs the compliance check
over them, refuses to label anything whose rollup is empty or stale, applies lane-verified, reads
the label back, removes the worktree, appends your tracker note with --append-notes, and drops
the lane lock last. It does that for EVERY open pull request whose head is this branch across the
repositories the workspace config names, not only the one you pass - so run it once, not once per
repository.

Exit 2 means non-compliant and NOTHING was labelled anywhere: it prints the offending lines
against the pull request they came from, you judge them, you fix the text, you re-run. A product
or vendor name that is the subject of the change is fine and the script cannot tell the difference
- that judgement is yours. Exit 4 is the same promise for a pull request that is not green.

Exit 5 means the label IS on and the worktree is gone, but the tracker note could not be
confirmed. Do not re-run it - repair only the note, the way its message says.

Exit 7 is NOT bad arguments: the set of pull requests on the branch could not be established -
the workspace config could not be read, or a repository's pull requests or labels would not list,
or the label could not be created in one of them. Nothing was labelled anywhere. Fix the one it
names and re-run it, and note that the last of those is a permissions answer rather than a
transient one: a repository that has no lane-verified label and will not take one needs somebody
with write access there to create it once. Labelling the half you know about by hand is the
failure it is refusing to cause.

Exit 8 means labelling began and stopped part-way, and it prints which pull requests carry the
label and which do not. Adding a label is idempotent and it stops before the worktree and the
note, so re-run it once the cause it quotes is gone. Never remove a label to tidy that up.

THE TRACKER NOTE must say the branch was rebased onto master, name the files that were resolved,
and say what was kept from each side.${afterRepair ? ` It must also say that CI was red on the rebased head, name
the files the repair step changed and what it changed in them - that is the only record of a
fix that was never reviewed as part of the branch.` : ''} Append it, never replace: the notes field has no history and
an overwrite is simply gone.

ONCE THE LABEL IS ON - lane-handoff.sh exited 0 or 5, and on no other exit - remove the task lane's
worktree that still has the branch checked out. lane-handoff.sh removes only the worktree it was
passed, which is this run's own detached one. The lane that built the branch ended without handing
off, so its worktree is still holding the branch, at the head this round superseded; left there it
refuses the next 'git worktree add' of the branch and trips the lander's --delete-branch. Run this
once, exactly as it stands:

  cd ${REPO_PATH} && held=$(git worktree list --porcelain | awk -v want='branch refs/heads/${BRANCH}' '/^worktree /{path=substr($0,10)} $0==want{print path; exit}') && main=$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}') && if [ -z "$held" ]; then echo "NO_HOLDER: nothing else has ${BRANCH} checked out"; elif [ "$held" = "$main" ]; then echo "REFUSED: $held is the main checkout, not a lane worktree"; else git worktree remove --force "$held" && git worktree prune && echo "REMOVED: $held"; fi

It matches on the 'branch refs/heads/...' line of 'git worktree list --porcelain' and on nothing
else: never a path guess, never the main checkout, and never this run's own worktree, which is
detached and has no branch line. On exit 2, 4, 7 or 8 LEAVE IT WHERE IT IS and report: until the
label is on, that worktree is the only copy of the lane's own state a person can still inspect.

Report the CI conclusion, whether the label is on, and what the removal printed.`
}

function repairPrompt(failures) {
  return `Pull request #${PR} on ${SLUG} was rebased onto current master, the rebase was clean or was
resolved, it was pushed, and CI is RED on the new head. This is a SEMANTIC conflict: the diff this
branch carries is the same one that was green before, and master moved underneath it - something
merged since changed a file, a symbol, a path or a rule that this branch's code or tests assumed.
Nothing in a rebase can see that, which is why the branch is here rather than merged.

YOUR JOB IS TO MEND THAT BREAK AND NOTHING ELSE. You get ONE attempt, and the next step waits
for CI once more. If it is red again the run ends and a person takes it, so a narrow fix that is
right beats a wide one that might be.

DO NOT REDESIGN, REBUILD OR "IMPROVE" THE FEATURE. Its work was reviewed and was green. If you
find yourself rewriting how it works rather than what it is plugged into, you have misread the
task: stop and report status "blocked" with what you found.

WHAT CI SAID, verbatim from the failed run:

${failures || '(the handoff step reported red and recorded no failures - read them yourself: gh run list --repo ' + SLUG + ' --branch ' + (resolved.branch || '<the branch>') + ' --limit 1 --json databaseId, then gh run view <id> --repo ' + SLUG + ' --log-failed)'}

${SHELL_FIRST}

THE WORKTREE IS ${WT_PATH}, on the branch as pushed. The lane lock is already held for this run;
do not take or release it. Record the head before you touch anything - the push at the end is
leased against it:

  cd ${WT_PATH} && git fetch origin && git status --short && git rev-parse HEAD
${railsSetup}
REPRODUCE IT LOCALLY FIRST. Run the repository's own checks in the worktree and read the failure
from the output, not from memory:
${repo.test ? `  tests:  ${repo.test}` : ''}
${repo.lint ? `  lint:   ${repo.lint}` : ''}
Narrow to the failing files while you work, and run everything once at the end. If the suite is
GREEN locally on the same head CI failed on, say so and report status "blocked" - a failure you
cannot reproduce is not one you can claim to have fixed, and a run's difference from CI is a
person's question.

THEN FIND WHAT MASTER CHANGED, because that is where the answer is. For each failing file:

  cd ${WT_PATH} && git log -p -5 origin/master -- <the file the failure names>
${resolved.oldHead && resolved.oldHead !== resolved.newHead
    ? `  cd ${WT_PATH} && git diff ${resolved.oldHead}...origin/master -- <that file>

The second command shows everything master gained in that file since the branch forked from it.`
    : `The branch already sat on top of master when this run began, so a three-dot diff from the head
it had would compare master with itself and show nothing - read the log above, and if the file
the failure names is one this branch changed, 'git log -p -10 origin/master -- <that file>' reaches
the commits master landed before the lander rebased onto them.`}

A compiler error naming a symbol that no longer exists, an import of a path master moved, a test
master added that asserts a rule this branch's code does not yet honour, a helper whose signature
changed - each one says exactly what to change. The three branches that first hit this on
2026-09-08 all imported collectionError from ./autofix.js after master had moved it to
./errors.js: two import lines, and nothing else.

MASTER IS WHAT LANDED, SO THE BRANCH ADAPTS TO MASTER. Never resolve the break by reverting or
softening what master did - not a test it added, not a rename, not a rule. If master's test and
this branch's intent genuinely contradict - the test asserts the opposite of what the branch
exists to do - that is a decision, not a repair: report status "blocked", quote both sides, and
name the commits. The same for a failure whose fix would weaken an assertion or delete a test.

Keep the change inside the files the failures name plus whatever they directly import. Write no
comments in the code. Match the surrounding style.

WHEN IT IS GREEN LOCALLY, commit and push:

  cd ${WT_PATH} && git add <the files you changed>
  cd ${WT_PATH} && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" commit -F <a message file>
  cd ${WT_PATH} && git push --force-with-lease=refs/heads/<the branch>:<the head you recorded> origin HEAD:refs/heads/<the branch>

ONE COMMIT ON TOP, not an amend: the commits underneath were reviewed and their messages are
theirs. BOTH ENDS OF THE PUSH ARE NAMED IN FULL because the worktree is detached - a bare 'origin
HEAD' has no branch to resolve its destination from and git refuses it. The lease is the safety
of the push - it refuses if the branch moved after you read it, which is exactly the case where
pushing would destroy somebody else's work. If it is refused, STOP and report "blocked" with what
git said. Never fall back to a plain --force.

THE COMMIT MESSAGE is outward-facing text: say what the code now does and what on master it
follows, in the words a person would use. Never mention the pipeline, lanes, labels, trains,
worktrees, temporary paths, CI runs by id, or any tooling or assistance. Read it back with
'git log -1 --format=%B' and check it yourself before pushing.

REPORT status "repaired" with the head you pushed and the files you changed, and in 'notes' what
master changed and what you changed to follow it - that text goes into the tracker and is the
only record of a fix nobody reviewed as part of the branch. The handoff step that follows writes
the tracker note for a repair that went through; you do not.

OR status "blocked" with why, in enough detail that a person can act without re-running anything.
ONLY WHEN YOU ARE BLOCKED: ${HAND_BACK}

Never use 2>&1.`
}

phase('Handoff')

handed = await agent(
  handoffPrompt(resolved.newHead, false),
  { schema: HANDOFF, phase: 'Handoff', label: ID ? `handoff:${ID}#${PR}` : `handoff:#${PR}` },
)

while (handed && handed.status === 'red' && repairs < MAX_REPAIRS) {
  repairs += 1
  phase('Repair')
  log(`${OWNER}: CI red on the rebased head - one repair attempt, then a person (repair ${repairs} of ${MAX_REPAIRS})`)
  repaired = await agent(
    repairPrompt(handed.failures || handed.notes),
    { schema: REPAIR, phase: 'Repair', label: ID ? `repair:${ID}#${PR}` : `repair:#${PR}` },
  )
  if (!repaired || repaired.status !== 'repaired') {
    handed = {
      ...handed,
      notes: `${handed.notes || 'CI red on the rebased head'}\n\nrepair: ${repaired ? (repaired.notes || 'blocked with no reason given') : 'the repair step returned nothing'}`,
    }
    break
  }
  if (repaired.head && resolved.newHead && repaired.head === resolved.newHead) {
    handed = {
      ...handed,
      notes: `${handed.notes || 'CI red on the rebased head'}\n\nrepair reported success but the branch head did not move (${repaired.head}). Nothing was pushed, so CI would answer the same way.`,
    }
    break
  }
  phase('Handoff')
  handed = await agent(
    handoffPrompt(repaired.head, true),
    { schema: HANDOFF, phase: 'Handoff', label: ID ? `handoff:${ID}#${PR}` : `handoff:#${PR}` },
  )
}

result = {
  pr: PR,
  id: ID,
  repo: REPO_KEY,
  outcome: handed ? handed.status : 'blocked',
  branch: resolved.branch || null,
  oldHead: resolved.oldHead || null,
  newHead: (repaired && repaired.status === 'repaired' && repaired.head) || resolved.newHead || null,
  files: resolved.files || [],
  repairs,
  repaired: repaired && repaired.status === 'repaired' ? (repaired.files || []) : [],
  ci: handed ? handed.ciConclusion : null,
  notes: handed ? handed.notes : 'handoff agent returned nothing',
}

}

} finally {
  const back = await agent(releaseLanePrompt(), { label: ID ? `release:${ID}#${PR}` : `release:#${PR}`, phase: 'Handoff', schema: LANE_BACK, model: 'haiku', effort: 'low' })
  laneLock = settle(LANE_LOCK, back && back.lane)
  slotClaim = settle(SLOT_FILE, back && back.slot)
  if (!GIVEN_BACK.has(back && back.lane) || !GIVEN_BACK.has(back && back.slot)) {
    log(`lane ${LANE}: ${laneLock}\n    slot ${SLOT}: ${slotClaim}${back && back.notes ? `\n    ${back.notes}` : ''}`)
  }
}

return { ...result, lane: laneLock, slot: slotClaim }
