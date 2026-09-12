export const meta = {
  name: 'devloop-rework',
  description: 'Bring a pull request that the release train dropped back onto current master, and hand it back green',
  phases: [
    { title: 'Resolve', detail: 'rebase the branch onto master, resolve conflicts keeping both sides, push' },
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
// So: two agents, no design, no review. Resolve, then hand back.

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
  return { status: 'error', notes: 'skillDir was not supplied. config.sh --args emits it; a hand-built args object must too. Refusing rather than running lanes against `undefined`.' }
}

const WT = input.worktrees || `/tmp/${LOCK_PREFIX}-worktrees`

const REPOS = input.repos

const PR = input.pr
const ID = input.id
const REPO_KEY = input.repo || 'site'
const SLOT = input.slot || 1
const LANE = SLOT + 1 // slot N takes lane N+1; the lane number is also TEST_ENV_NUMBER
const LANE_LOCK = `/tmp/${LOCK_PREFIX}-lane-${LANE}.lock`
const OWNER_FILE = `/tmp/${LOCK_PREFIX}-lane-${LANE}.owner`
const SLOT_FILE = input.slot ? `/tmp/${LOCK_PREFIX}-slots/${SLOT}` : null
const GIVEN_BACK = new Set(['released', 'already_gone'])

const repo = REPOS[REPO_KEY]
if (!PR) return { error: 'no pull request number given - call with args: { pr: 739, id: "sr-x", repo: "site", slot: 4 }' }
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

const SLOT_ARG = SLOT_FILE ? ` --slot ${SLOT_FILE}` : ''
const SLOT_SAID = SLOT_FILE ? ` and slot ${SLOT}` : ''
const NO_SLOT = 'not_reserved - this run carried no slot, so it has no reservation to give back'

const LANE_BACK = {
  type: 'object',
  required: SLOT_FILE ? ['lane', 'slot'] : ['lane'],
  properties: {
    lane: { enum: ['released', 'not_mine', 'already_gone', 'still_held'], description: 'the word release-lane.sh printed after lane:, lowercased - it reports its own outcome and you are not asked to judge it' },
    slot: { enum: ['released', 'not_mine', 'already_gone', 'still_held'], description: 'the word it printed after slot:, lowercased' },
    notes: { type: 'string', description: 'everything it printed, verbatim' },
  },
}

function releaseLanePrompt() {
  return `Give lane ${LANE}${SLOT_SAID} back. Run this command once, exactly as it stands, and
report what it printed:

  bash ${SKILL_DIR}/release-lane.sh --lane ${LANE_LOCK}${SLOT_ARG} --owner '${OWNER}'

Every value is already in the command. There is nothing to look up, substitute or confirm first,
and nothing for you to judge: the script proves ownership itself - the owner file beside the lock${SLOT_FILE ? `
and the id in the slot file` : ''} - and removes only what names this run. An earlier release step of
this shape was told to supply a value it had already been given, went looking for it, found none
and declined to touch the lock at all, which left every other lane waiting on it.

Report the word after 'lane:' as 'lane'${SLOT_FILE ? `, the word after 'slot:' as 'slot'` : ''}, lowercased, and
everything it printed as 'notes'.${SLOT_FILE ? '' : ` This run carried no slot, so the command names none, the
script prints no slot line, and there is nothing to report for one.`} Remove nothing by hand, run no other
command, and never use 2>&1.`
}

function settle(path, answer) {
  if (GIVEN_BACK.has(answer)) return answer
  if (answer === 'not_mine') return `not_mine - ${path} does not record ${OWNER}, so nothing was removed and nothing should be`
  return `LEAKED - ${path} was not given back, or the release step answered nothing. Read it before removing anything: clear it if it records this run, and leave it alone if it records another.`
}

let laneLock = `LEAKED - the release step never reported. Read ${LANE_LOCK} before touching anything.`
let slotClaim = SLOT_FILE ? `LEAKED - the release step never reported. Read ${SLOT_FILE} before touching anything.` : NO_SLOT
let result = null

try {

phase('Resolve')

const resolved = await agent(
  `Bring pull request #${PR} on ${SLUG} back onto current master. It was DROPPED by the release
train for conflicting - not rejected, not found wrong. Its own work is fine and shipped green.
Your job is bringing it up to master, and nothing else.

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
  git worktree add ${WT_PATH} -B "$branch" "origin/$branch"

Record the branch head BEFORE you touch it - you will need to prove it moved:
  git -C ${WT_PATH} rev-parse HEAD
${railsSetup}
TAKE THE LABEL OFF WHILE YOU WORK. lane-verified is the lander's signal that a branch is ready,
and it is currently sitting on a head that cannot merge. Remove it now and let the handoff step
put it back once CI is green on the new head:

  gh pr edit ${PR} --repo ${SLUG} --remove-label lane-verified

REBASE ONTO MASTER. Do not merge master in.

  cd ${WT_PATH} && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" rebase origin/master

The rebase stops at each commit that conflicts. Resolve inside the conflict regions, stage what
you resolved, and continue:

  cd ${WT_PATH} && git add <the files you resolved>
  cd ${WT_PATH} && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" rebase --continue

THE IDENTITY GOES ON '--continue' TOO, not only on the first command. Continuing is what writes
the replayed commit, so without it the rebase stops again with 'unable to auto-detect email
address' and leaves the branch mid-rebase.

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
                        git checkout --theirs db/schema.rb   # or: git checkout origin/master -- db/schema.rb
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

  cd ${WT_PATH} && git push --force-with-lease=<the branch>:<the head you recorded> origin HEAD

The lease is the whole safety of this step: it refuses if the branch moved after you read it,
which is exactly the case where forcing would destroy somebody else's work. If the lease is
refused, STOP and report status "blocked" with what git said. Never fall back to a plain --force,
and never widen the lease to the bare branch name.

COMMIT MESSAGE RULES. A rebase composes no message of its own: the replayed commits keep the ones
the branch already carried, so there is nothing here for you to write. If a resolution makes one of
those messages wrong and you amend it, it is outward-facing text - say what the code does in the
words a person would use, never mention the pipeline, lanes, labels, trains, worktrees, temporary
paths, or any tooling or assistance, and read it back from git afterwards and check it yourself.

REPORT: status, the branch name, the old head, the new head, and the files you resolved. If the
rebase turns out to be clean already because something else landed in the meantime, that is
status "already_clean" - say so rather than inventing a change.`,
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

// A head that did not move means nothing was pushed, whatever the agent believes it did. The
// whole point of this run is that the branch changes; reporting success without that is how a
// pull request gets handed back into a train that drops it again for the same reason.
if (!result && resolved.status === 'resolved' && resolved.oldHead && resolved.newHead && resolved.oldHead === resolved.newHead) {
  result = {
    pr: PR,
    id: ID,
    outcome: 'blocked',
    notes: `resolve reported success but the branch head did not move (${resolved.oldHead}). Nothing was pushed, so the next train would drop this again for the same conflicts.`,
  }
}

if (!result) {

phase('Handoff')

const HANDOFF = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['verified', 'red', 'blocked'] },
    ciConclusion: { type: 'string' },
    mergeable: { type: 'string' },
    notes: { type: 'string' },
  },
}

const handed = await agent(
  `Pull request #${PR} on ${SLUG} has been rebased onto current master and pushed. Wait for CI on
the NEW head and hand it back to the lander.

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

If CI comes back RED, read the failures. A failure in a file you resolved is very likely your
resolution having dropped one side of a conflict - go back and look at both sides again rather
than adjusting the test. Report status "red" with what failed; do not label it.

WHEN IT IS GREEN, hand off with the script rather than by hand:

  bash ${SKILL_DIR}/lane-handoff.sh --repo-path ${REPO_PATH} --slug ${SLUG} \\
    --pr ${PR} --branch ${resolved.branch || '<the branch>'} \\
    ${ID ? `--issue ${ID} --note-file <a file holding your tracker note>` : ''} \\
    --worktree ${WT_PATH} \\
    --lane-lock ${LANE_LOCK}

It reads the title, body and commit messages back from GitHub and git, runs the compliance check
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
and say what was kept from each side. Append it, never replace: the notes field has no history and
an overwrite is simply gone.

Report the CI conclusion and whether the label is on.`,
  { schema: HANDOFF, phase: 'Handoff', label: ID ? `handoff:${ID}#${PR}` : `handoff:#${PR}` },
)

result = {
  pr: PR,
  id: ID,
  repo: REPO_KEY,
  outcome: handed ? handed.status : 'blocked',
  branch: resolved.branch || null,
  oldHead: resolved.oldHead || null,
  newHead: resolved.newHead || null,
  files: resolved.files || [],
  ci: handed ? handed.ciConclusion : null,
  notes: handed ? handed.notes : 'handoff agent returned nothing',
}

}

} finally {
  const back = await agent(releaseLanePrompt(), { label: ID ? `release:${ID}#${PR}` : `release:#${PR}`, phase: 'Handoff', schema: LANE_BACK, model: 'haiku', effort: 'low' })
  laneLock = settle(LANE_LOCK, back && back.lane)
  if (SLOT_FILE) slotClaim = settle(SLOT_FILE, back && back.slot)
  if (!GIVEN_BACK.has(back && back.lane) || (SLOT_FILE && !GIVEN_BACK.has(back && back.slot))) {
    log(`lane ${LANE}: ${laneLock}${SLOT_FILE ? `\n    slot ${SLOT}: ${slotClaim}` : ''}${back && back.notes ? `\n    ${back.notes}` : ''}`)
  }
}

return { ...result, lane: laneLock, slot: slotClaim }
