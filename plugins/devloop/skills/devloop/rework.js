export const meta = {
  name: 'devloop-rework',
  description: 'Bring a pull request that the release train dropped back onto current master, and hand it back green',
  phases: [
    { title: 'Resolve', detail: 'merge master into the branch, resolve conflicts keeping both sides, push' },
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

const repo = REPOS[REPO_KEY]
if (!PR) return { error: 'no pull request number given - call with args: { pr: 739, id: "sr-x", repo: "site", slot: 4 }' }
if (!repo) return { error: `unknown repo ${REPO_KEY} - expected one of ${Object.keys(REPOS).join(', ')}` }

const SLUG = repo.slug
const REPO_PATH = `${ROOT}/${repo.path}`
const WT_PATH = `${WT}/${ID || `pr-${PR}`}-rework`

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

phase('Resolve')

const resolved = await agent(
  `Bring pull request #${PR} on ${SLUG} back onto current master. It was DROPPED by the release
train for conflicting - not rejected, not found wrong. Its own work is fine and shipped green.
Your job is the merge, and nothing else.

DO NOT REDESIGN, REBUILD OR "IMPROVE" ANYTHING ON THIS BRANCH. If you find yourself writing a
feature, you have misread the task. The only edits you make are inside conflict regions.

TAKE THE LANE LOCK FIRST, so you do not share a test database with another lane:

  mkdir /tmp/${LOCK_PREFIX}-lane-${LANE}.lock 2>/dev/null && echo GOT_LANE || echo LANE_BUSY

If it prints LANE_BUSY, wait and retry rather than proceeding without it.

DO NOT RELEASE IT YOURSELF. Hold it until the end; the handoff step passes it to
lane-handoff.sh, which drops it last, after the label is on. An earlier version of this told you
to rmdir it once the suite finished AND passed --lane-lock to the script - so the lock was
already gone by the time the script looked, and the script's rmdir tolerates absence, which
means its exit 0 was not evidence the lock had ever been held. The window between your last
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

MERGE MASTER IN. Do not rebase.

  cd ${WT_PATH} && git merge --no-ff --no-commit origin/master

and then write the commit message YOURSELF, because a generated one says nothing. Its default
reads

  Merge remote-tracking branch 'origin/master' into devloop/<id>

which tells a reader neither what conflicted nor what was kept. Say what the merge did instead:

  git commit -F <a file with your message>

Something like "Merge master into the <what this branch is> branch", then a paragraph naming the
files that conflicted and what was kept from each side.

A NOTE ON THE COMPLIANCE CHECK, because this was got wrong once. The default message trips the
leakage pattern on the branch name, and on 2026-08-30 a whole branch history was collapsed and
force-pushed to remove that one line. That was over-cautious. The rule forbids claiming the work
was written or assisted by an AI; a branch name is not such a claim, it is already public in the
pull request's own headRefName, and this repository documents its pipeline openly. A lane that
reads such a hit and judges it a keep is doing exactly what the script asks - the refusal exists
so somebody looks, not so everything it flags gets deleted. Write a real message because a
generated one is useless to a reader, not because the generated one is forbidden.

Merge, not rebase, for two reasons. The train squashes every branch it takes
(git merge --squash), so a merge commit on this branch never reaches master and costs nothing.
And a rebase rewrites published history and needs a force-push, which turns a recoverable
mistake into an unrecoverable one on a branch somebody may be reading.

RESOLVING. Most conflicts here are one shape: master added entries and this branch added
different ones, in the same region. KEEP BOTH SIDES. Taking one side wholesale - --ours, --theirs,
or picking whichever block looks more complete - silently deletes work that is already on master
or already reviewed on this branch, and the suite may well stay green while it does.

"KEEP BOTH" IS ABOUT ADDITIONS, AND IT IS THE WRONG RULE WHEN THE BRANCH DELETED SOMETHING ON
PURPOSE. Before applying it, ask what each side actually did to the region: added, changed, or
removed. A branch that removes an entry must have that removal honoured, or the merge quietly
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

RUN THE TESTS THAT COVER THE CONFLICTED FILES, not the whole suite - the full suite is CI's job
and takes ten minutes locally against about two and a half in CI. If a conflicted file is a spec,
run that spec. If it is a script with its own check, run that check. Say which you ran.
${repo.test ? `  tests:  ${repo.test}` : ''}
${repo.lint ? `  lint:   ${repo.lint}` : ''}

PUSH to the same branch. No force. If a plain push is refused, STOP and report status "blocked"
with what git said - a refused push means somebody else moved the branch, and forcing over them
is exactly the unrecoverable case this instruction exists to prevent.

COMMIT MESSAGE RULES. The message is outward-facing text. Say what the merge did in the words a
person would use - which entries were kept from each side. Never mention the pipeline, lanes,
labels, trains, worktrees, temporary paths, or any tooling or assistance. Read the message back
from git after committing and check it yourself.

REPORT: status, the branch name, the old head, the new head, and the files you resolved. If the
merge turns out to be clean already because something else landed in the meantime, that is
status "already_clean" - say so rather than inventing a change.`,
  { schema: RESOLVE, phase: 'Resolve', label: `resolve:#${PR}` },
)

if (!resolved || resolved.status === 'blocked') {
  return {
    pr: PR,
    id: ID,
    outcome: 'blocked',
    notes: resolved ? resolved.notes : 'resolve agent returned nothing',
  }
}

// A head that did not move means nothing was pushed, whatever the agent believes it did. The
// whole point of this run is that the branch changes; reporting success without that is how a
// pull request gets handed back into a train that drops it again for the same reason.
if (resolved.status === 'resolved' && resolved.oldHead && resolved.newHead && resolved.oldHead === resolved.newHead) {
  return {
    pr: PR,
    id: ID,
    outcome: 'blocked',
    notes: `resolve reported success but the branch head did not move (${resolved.oldHead}). Nothing was pushed, so the next train would drop this again for the same conflicts.`,
  }
}

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
  `Pull request #${PR} on ${SLUG} has been merged up to current master and pushed. Wait for CI on
the NEW head and hand it back to the lander.

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
    --pr ${PR} --branch ${resolved.branch || '<the branch>'} ${ID ? `--issue ${ID}` : ''} \\
    --note-file <a file holding your tracker note> --worktree ${WT_PATH} \\
    --lane-lock /tmp/${LOCK_PREFIX}-lane-${LANE}.lock

It reads the title, body and commit messages back from GitHub and git, runs the compliance check
over them, refuses to label anything whose rollup is empty or stale, applies lane-verified, reads
the label back, removes the worktree, appends your tracker note with --append-notes, and drops
the lane lock last.

Exit 2 means non-compliant and NOTHING was labelled: it prints the offending lines, you judge
them, you fix the text, you re-run. A product or vendor name that is the subject of the change is
fine and the script cannot tell the difference - that judgement is yours.

THE TRACKER NOTE must say the branch was brought up to master, name the files that were resolved,
and say what was kept from each side. Append it, never replace: the notes field has no history and
an overwrite is simply gone.

Report the CI conclusion and whether the label is on.`,
  { schema: HANDOFF, phase: 'Handoff', label: `handoff:#${PR}` },
)

return {
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
