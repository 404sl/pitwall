export const meta = {
  name: 'land-train',
  description: 'Land every ready pull request as one release train: build it, test it once, merge, deploy, close',
  whenToUse: 'When lane-verified pull requests are queued and the merge lock is free. If this run ends with stopped=merge_refused, the supervisor must run `gh pr view <trainPr> --repo <slug> --json labels,statusCheckRollup` in ITS OWN transcript and then RESUME with resumeFromRunId - the merge agent checking the PR itself does not count, and rerunning from scratch cuts a second release branch for the same PRs.',
  phases: [
    { title: 'Lock', detail: 'take the merge lock, or stand down' },
    { title: 'Build', detail: 'squash the ready branches onto one branch cut from master' },
    { title: 'Verify', detail: 'one CI run over the whole train, bisecting on red' },
    { title: 'Merge', detail: 'merge the train, confirm master' },
    { title: 'Deploy', detail: 'staging and production, once' },
    { title: 'Close', detail: 'retire the issues the train landed' },
  ],
}

// CONFIGURATION ARRIVES IN args, the way task.js and land.js take it. It used to be constants -
// ROOT and four slugs written into this file with no override - which is worse than the fallback
// removed from land.js on 2026-09-09, because there was not even an escape hatch: another
// workspace running this file would MERGE AND DEPLOY against one workspace with no way to say
// otherwise, and this one deploys.
//
// That was the fourth instance of one shape found in a day, all four by a workspace other than
// the one that wrote them. A default that is right for its author is invisible to its author.
const input = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const SKILL_DIR = input.skillDir
const ROOT = input.root

// FOUR REPOSITORIES CARRY lane-verified PULL REQUESTS, NOT ONE. An earlier version of this file
// hardcoded site, which silently stranded every extension change - #118 sat labelled and green
// with nothing that would ever pick it up. A train runs against ONE repository at a time; run it
// again per repository.
//
// deploys: only site has somewhere to deploy TO. The extension ships through store review, and
// integration is published by hand because the npm account has two-factor. Running site's mina
// commands against either would be wrong, so the deploy phase is skipped where deploys is false.
// From the config, a repo deploys when its entry carries a deploy array.
const REPOS = input.repos
  ? Object.fromEntries(Object.entries(input.repos).map(([name, r]) => [name, {
      path: (r || {}).path || name,
      slug: (r || {}).slug,
      deploys: Array.isArray((r || {}).deploy) && (r || {}).deploy.length > 0
    }]))
  : {
      site: { path: 'site', slug: 'your-org/your-app', deploys: true },
      extension: { path: 'extension', slug: 'your-org/your-ext', deploys: false },
      integration: { path: 'integration', slug: 'your-org/your-integration', deploys: false },
      docs: { path: 'docs', slug: 'your-org/your-docs', deploys: false },
    }

const REPO_KEY = (args && args.repo) || 'site'
const REPO = REPOS[REPO_KEY]
if (!REPO) {
  return { status: 'error', notes: `unknown repo ${REPO_KEY} - expected one of ${Object.keys(REPOS).join(', ')}` }
}
// A SLUG IS NEVER GUESSED. Checked here, on the way in, before the merge lock is taken and
// before any agent is spawned - a run that discovers this later would abort holding the lock,
// and the release step is exactly the one that would not run.
if (!REPO.slug) {
  return {
    status: 'error',
    notes: `no slug configured for repo '${REPO_KEY}'. Add slug: "owner/name" to its entry in ` +
           `the repos config. This will not guess one: on 2026-09-09 a guessed slug had one ` +
           `workspace assembling squash merges against another project's repository.`
  }
}
const REPO_PATH = `${ROOT}/${REPO.path}`
const SLUG = REPO.slug
const MAX = (args && args.max) || 8
const MAX_BISECT_DEPTH = 2

// An explicit list, when the caller has a reason to hold something back that the script cannot
// see - typically a branch being rebased right now in a lane, whose files another queued pull
// request also touches. Being BEHIND master is not such a reason: the train squashes onto a
// fresh cut and does not care how far back a branch was cut. Only a file-level conflict drops
// anything, so hold back overlap, not staleness.
const ONLY = (args && args.only) || null

const BUILT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['built', 'empty', 'master_red', 'error'] },
    trainPr: { type: ['number', 'null'] },
    trainBranch: { type: ['string', 'null'] },
    included: { type: 'array', items: { type: 'number' } },
    skipped: { type: 'array', items: { type: 'number' } },
    notes: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['green', 'red', 'unknown'] },
    failingSpecs: { type: 'array', items: { type: 'string' } },
    rerunTried: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const MERGED = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['merged', 'refused'] },
    mergeSha: { type: ['string', 'null'] },
    masterGreen: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

function buildPrompt(only, suffix) {
  const onlyArg = only ? ` --only "${only.join(' ')}"` : ''
  const suffixArg = suffix ? ` --suffix ${suffix}` : ''
  return `Build a release train and report what went on it. ONE command does the work:

  bash ${SKILL_DIR}/land-train.sh --repo-path ${REPO_PATH} --slug ${SLUG} --max ${MAX}${onlyArg}${suffixArg}

Read its exit code and its stdout, and return them faithfully:

  0  status "built".   Take trainPr from the PR=<n> line, trainBranch from the "built:" line,
                       and included/skipped from the "added"/"skipped" lines. Every number you
                       report must appear in the output - do not infer any.
  2  status "empty".   Nothing carried the label, or everything was skipped.
  5  status "master_red".
  6  status "error".   Report the message verbatim in notes.

DO NOT MERGE ANYTHING. DO NOT WAIT FOR CI. DO NOT DEPLOY. The script opens a pull request and
stops on purpose; a later step tests it.

If the script drops a branch as conflicting, that is information, not a failure - report it in
skipped and move on. Do not try to resolve a conflict and do not re-run the script to get a
different answer.`
}

function verifyPrompt(trainPr, included) {
  return `The release train is pull request #${trainPr} on ${SLUG}, carrying ${included.length}
change(s): ${included.join(', ')}. Find out whether it is green.

  cd ${REPO_PATH} && gh pr checks ${trainPr} --repo ${SLUG} --watch --fail-fast

That call BLOCKS until the checks finish - it does not poll and you must not wrap it in a loop
or a sleep. When it returns, read the rollup back rather than trusting the exit code:

  gh pr view ${trainPr} --repo ${SLUG} --json statusCheckRollup,headRefOid

AN EMPTY ROLLUP IS NOT A PASS. "Every entry is green" is vacuously true of an empty array. If it
is empty, wait for the checks to register and read it again; report "unknown" only if it stays
empty after a second look.

ON RED, RE-RUN ONCE BEFORE BELIEVING IT. This suite has a known intermittent-failure problem -
five instances are recorded on app-nnpg, most of them "the element was there but not yet
clickable". A re-run of the identical commit is the cheapest way to tell a flake from a break:

  gh run rerun <run-id> --failed
  gh run watch <run-id> --exit-status --interval 15

Set rerunTried true when you do this. If the re-run passes, the train is green - say so, and put
the name of the flaky spec in failingSpecs anyway so it can be recorded against app-nnpg.

If it fails again, it is real. Report status "red" and put EVERY failing spec locator in
failingSpecs, in the form ./spec/path/file_spec.rb:42. Those locators are what the next step
uses, so do not summarise or truncate the list.

DO NOT FIX ANYTHING. Do not open a pull request, do not edit a spec, do not investigate beyond
naming what failed. A previous lander spent nineteen minutes diagnosing a flake while holding
the merge lock and blocking every other change. Name it and hand it back.

NEVER CHANGE THE WORKING TREE OF ${REPO_PATH}. A person works in that checkout and it may hold
uncommitted edits that exist nowhere else. These commands are forbidden there, without exception:

  git checkout <anything>        git switch        git reset        git stash        git clean

On 2026-08-29 a verify agent ran 'git checkout <sha> -- .' in that checkout to read a failing
spec. It staged thirty files over the person's working tree. It was survivable only because the
tree happened to be clean at that moment, which is luck, not a safeguard.

TO READ A FILE AT A COMMIT, ASK GIT FOR ITS CONTENT INSTEAD OF MOVING THE TREE TO IT:

  git show <sha>:spec/system/whatever_spec.rb | sed -n '30,75p'
  git show origin/master:config/importmap.rb | grep prism

That prints the file as it is at that commit and touches nothing. It is strictly better for this
purpose anyway - no cleanup, no risk, and it works while another agent is using the checkout.`
}

function mergePrompt(trainPr, trainBranch, included) {
  return `Merge the release train, pull request #${trainPr} (${trainBranch}) on ${SLUG}. Its
checks are green - a previous step verified that.

FIRST show the evidence in your own transcript, then merge:

  cd ${REPO_PATH} && gh pr view ${trainPr} --repo ${SLUG} --json labels,statusCheckRollup
  gh pr merge ${trainPr} --repo ${SLUG} --merge --delete-branch

USE --merge, NOT --squash. The train's commits are already one per pull request, and each
carries a "Closes #<n>" line that retires the original pull request when it reaches master.
Squashing here would rewrite them and every one of ${included.join(', ')} would sit open looking
unlanded.

Then confirm master, and confirm the pull requests actually closed:

  git fetch origin --quiet && git log -1 --format='%H' origin/master
  gh run list --branch master --limit 1 --json status,conclusion
  gh pr view <n> --repo ${SLUG} --json state    for each of ${included.join(', ')}

Report mergeSha, masterGreen, and in notes: any of those pull requests that is NOT closed. Do
not close them by hand here - just say which, so it is visible rather than quietly patched.

If master's run is still in progress, wait for it with gh run watch rather than reporting a
guess. If master goes RED after this merge, say so plainly and set masterGreen false - that is
the one outcome that must not be softened, because the next train will refuse to build on it.`
}

function deployPrompt(mergeSha, included) {
  return `Deploy master to staging AND production. Master is at ${mergeSha}, which carries
${included.length} change(s): ${included.join(', ')}.

  cd ${REPO_PATH}
  git fetch origin --quiet && git log -1 --format='%H' origin/master

Confirm the sha above is what origin/master actually points at BEFORE deploying. If it is not,
stop and report it rather than deploying something else.

Then deploy each environment with this, STAGING FIRST:

  bash ~/.claude/skills/devloop/deploy-one.sh --label staging --repo-path ${REPO_PATH} --deploy 'bundle exec mina staging deploy' --revision 'curl -s -m 20 https://staging.example.com/health | sed -n "s/.*\\"git_revision\\":\\"\\([0-9a-f]*\\)\\".*/\\1/p"' --timeout 1500

  bash ~/.claude/skills/devloop/deploy-one.sh --label production --repo-path ${REPO_PATH} --deploy 'bundle exec mina production deploy' --revision 'curl -s -m 20 https://example.com/health | sed -n "s/.*\\"git_revision\\":\\"\\([0-9a-f]*\\)\\".*/\\1/p"' --timeout 1500

RUN EACH OF THOSE IN THE FOREGROUND, one Bash call each, with the call's own timeout set to
1800000. Do NOT background them and then block on a 'tail -f' of the output file. Two reasons.
A backgrounded command is killed when the agent that started it ends, so anything that cuts the
agent short takes an in-flight production deploy with it and leaves no record of what happened.
And an agent blocked on a long 'tail -f' writes NOTHING to its transcript for the whole wait,
which is what a dead run looks like from outside - on 2026-09-06 a supervisor read exactly that,
plus production still a release behind, concluded the train had died, cleared its merge lock and
hand-deployed production. The train was alive and mid-deploy; the server ended up with two
production releases 101 seconds apart and a second train running against the same repository.
A foreground call cannot vanish and its result is in the transcript.

The revision is read from /health rather than over ssh on purpose: it needs no session, and it
is the sha the outside world is actually being served.

DO NOT run the mina commands directly, and DO NOT chain the two environments with '&&'. The
script exists because mina's exit code does not tell you whether the deploy happened: on
2026-09-04 a staging deploy finished completely on the server - lock removed, symlink moved,
revisions.log written - and then hung locally for 21 minutes, so the second command never ran and
production silently stayed a release behind with nothing reporting an error. The script bounds
the deploy with a timeout and then decides by reading the sha back off the server, which is the
right answer in both directions: killed but serving the sha is a success, exited 0 but not
serving it is a failure.

ITS EXIT CODE IS THE ONE TO TRUST, not mina's output. If STAGING does not exit 0, STOP - report
it and do NOT deploy production, because staging broken with production shipped is the same
forbidden split mirrored.

BOTH environments, always. The extension has an environment switcher, so a server change live in
only one of them is live in neither as far as a tester is concerned.

BEFORE YOU START, read both environments and say what you found:

  for h in staging.example.com example.com; do echo -n "$h "; curl -s -m 20 "https://$h/health" | sed -n 's/.*"git_revision":"\\([0-9a-f]*\\)".*/\\1/p'; echo; done

If staging is ALREADY at the merge sha and production is not, say so and deploy production only -
do not re-deploy staging. Note that this is also exactly what a train looks like WHILE it is
deploying, so if you are not that train, confirm no other run is in flight before acting on it.

THIS STEP MERGES NOTHING. Everything is already on master.`
}

function closePrompt(landed, mergeSha) {
  return `These changes are on master at ${mergeSha} and deployed to staging and production:

${landed.map((n) => `  ${SLUG}#${n}`).join('\n')}

EVERY gh CALL NEEDS --repo ${SLUG}. PULL REQUEST NUMBERS ARE PER REPOSITORY, and this project has
four of them. Without --repo, gh resolves the number against whatever repository the working
directory belongs to, silently returns a DIFFERENT project's pull request with the same number,
and the branch and body you then read belong to something else entirely.

That is not hypothetical. On 2026-08-30 a docs train was asked to close #54 and #55; the agent
read two unrelated pull requests, correctly found no matching tracker issue for either, and
reported "none - neither resolves to an open bd issue". Both docs issues stayed in_progress,
which held them out of the ready queue until a triage scan called them dead lanes. The same thing
had already happened to two extension issues.

It only bites the small-numbered repositories. The site is past #780, so its numbers collide with
nothing; docs, extension and integration are all in double digits and collide with each other.

  gh pr view <n> --repo ${SLUG} --json headRefName,body,title

Close the tracker issues they came from. Run bd from
the workspace root - not from inside a repository.

For each pull request, find its issue (the branch is devloop/<issue-id>, and the issue is also
named in the pull request body), then:

  bd update <id> --append-notes "<what landed, and the merge sha>"
  bd close <id>

--append-notes, NEVER --notes. The notes field has no history and an overwrite is simply gone;
that has already destroyed a recorded decision on this tracker.

THAT LIST IS THE WHOLE JOB. Do not survey the tracker for other issues, do not close anything
that is not above, and do not reopen anything. If an issue is already closed, say so and move
on. If a pull request has no issue you can identify, say which - do not guess.

Report the issues you closed and any you could not.

Before reporting "no issue found" for any pull request, CHECK YOU READ THE RIGHT ONE: the branch
name you got back should start with devloop/, and the issue id in it should exist in bd. A branch
that looks nothing like devloop/<id> means you read another repository's pull request and the
answer is to retry with --repo, not to report the issue as unidentifiable.`
}

phase('Lock')
const lock = await agent(
  `Take the serial merge lock so only one lander runs at a time:

  mkdir /tmp/devloop-merge.lock 2>/dev/null && echo "TAKEN" || echo "HELD"

If it prints HELD, another lander is running: report status "held" and DO NOTHING ELSE. Do not
remove the lock, do not wait for it, do not proceed.

If it prints TAKEN, STAMP THE LOCK WITH AN IDENTITY THAT IS YOURS. The holder file used to say
just "lander", which identifies nothing, so the release step could not prove the lock it was
about to delete was its own - it removed a shared resource unconditionally, which is rightly
refused, and every train leaked its lock and needed clearing by hand. Mint a token instead:

  TOKEN="land-train-$(date +%s)-$$"
  printf '%s\\n' "$TOKEN" > /tmp/devloop-merge.lock/holder
  cat /tmp/devloop-merge.lock/holder

Report status "taken" and the token EXACTLY as cat printed it back, not as you intended to write
it. The release step will remove the lock only if the holder still reads exactly this, so a token
you report but did not write means a lock nobody can release.`,
  { schema: { type: 'object', required: ['status'], properties: {
      status: { type: 'string', enum: ['taken', 'held'] }, token: { type: 'string' } } },
    model: 'haiku', effort: 'low', phase: 'Lock' },
)

if (!lock || lock.status !== 'taken') {
  return { status: 'held', notes: 'Another lander holds /tmp/devloop-merge.lock. Nothing was done.' }
}

const landed = []
const rejected = []
const flakes = []
// Every pull request any build dropped for conflicting. A drop is silent by design - the train
// carries on rather than stalling - but nothing re-queues a dropped branch, so it is dropped
// again by every later train until somebody rebases it. Four sat that way for a whole afternoon
// on 2026-08-29 and were only found by going to look. Collected here so the run can say so.
const skipped = new Set()
let lastSha = null

// Build a train, test it, and merge it if green. On red, split and recurse: the failure is in one
// half or the other, and log2(n) CI runs finds it. Depth is capped because a train that keeps
// failing is telling us something a bisect cannot fix - at that point every remaining branch is
// handed back rather than ground through one at a time.
async function runTrain(only, suffix, depth) {
  const built = await agent(buildPrompt(only, suffix), { schema: BUILT, phase: 'Build', label: `build:${suffix || 'full'}` })
  if (!built || built.status !== 'built') {
    return { stopped: built ? built.status : 'error', notes: built ? built.notes : 'build agent returned nothing' }
  }

  for (const n of built.skipped || []) skipped.add(n)

  const included = built.included || []
  if (!included.length) return { stopped: 'empty' }

  const verdict = await agent(verifyPrompt(built.trainPr, included), {
    schema: VERDICT, phase: 'Verify', label: `verify:#${built.trainPr}`,
  })

  if (verdict && verdict.failingSpecs && verdict.failingSpecs.length) flakes.push(...verdict.failingSpecs)

  if (verdict && verdict.status === 'green') {
    const merged = await agent(mergePrompt(built.trainPr, built.trainBranch, included), {
      schema: MERGED, phase: 'Merge', label: `merge:#${built.trainPr}`,
    })
    if (merged && merged.status === 'merged') {
      landed.push(...included)
      lastSha = merged.mergeSha || lastSha
      if (merged.masterGreen === false) {
        return { stopped: 'master_red_after_merge', notes: merged.notes }
      }
      return { stopped: null }
    }
    return { stopped: 'merge_refused', notes: merged ? merged.notes : 'merge agent returned nothing' }
  }

  // RED, SO THE TRAIN IS OVER - RETIRE IT BEFORE DOING ANYTHING ELSE. A merged train is removed
  // by --delete-branch; a red one is not, and nothing else was removing it. Four release
  // branches and their pull requests were left on the remote by 2026-08-29 evening, each looking
  // like an open change somebody might read. The pull request is closed rather than left open
  // because it proposes merging a set that has just been proven not to work.
  await agent(
    `The release train ${built.trainBranch}, pull request #${built.trainPr} on ${SLUG}, failed its
checks and is being abandoned. Retire it so it does not sit on the remote looking like open work:

  cd ${REPO_PATH}
  gh pr close ${built.trainPr} --repo ${SLUG} --delete-branch --comment "<one line: failed CI, the changes it carried are going back to the queue and will be tried again separately>"
  git fetch origin --prune --quiet
  git branch -r --list 'origin/${built.trainBranch}'

The last command must print NOTHING. If the branch is still listed, say so - a leftover train
branch is clutter that outlives the run and nobody else removes it.

DO NOT touch the pull requests it carried (${included.join(', ')}). They keep their labels and
go back in the queue; closing them would throw away work that is probably fine. Only the train
branch and the train's own pull request are yours to remove.`,
    { model: 'haiku', effort: 'low', phase: 'Verify', label: `retire:#${built.trainPr}` },
  )

  // One branch left means the culprit is identified.
  if (included.length === 1) {
    rejected.push(included[0])
    log(`#${included[0]} fails on its own - handing it back`)
    return { stopped: null }
  }
  if (depth >= MAX_BISECT_DEPTH) {
    rejected.push(...included)
    log(`bisect depth reached with ${included.length} still failing - handing all of them back`)
    return { stopped: null }
  }

  const half = Math.ceil(included.length / 2)
  log(`train of ${included.length} is red - splitting into ${half} and ${included.length - half}`)
  const a = await runTrain(included.slice(0, half), `${suffix || 'b'}a${depth}`, depth + 1)
  if (a.stopped) return a
  return runTrain(included.slice(half), `${suffix || 'b'}b${depth}`, depth + 1)
}

const outcome = await runTrain(ONLY, '', 0)

// A RED MASTER IS NEVER DEPLOYED. This condition used to be `landed.length && lastSha` alone,
// and that is not the same thing as "it went well": runTrain pushes to `landed` BEFORE it
// returns master_red_after_merge, so a train that correctly detected a red master, correctly
// refused to call it green, and correctly reported stopped: 'master_red_after_merge' then fell
// straight through to this block and deployed it anyway.
//
// That happened on 2026-08-30 with 593a481a. It was harmless only by luck - the red was a flaky
// spec and the commit was fine - but the pipeline had shipped a commit its own gate had just
// judged unfit, and reported both facts in the same result without noticing they contradicted.
//
// Only this one stop reason blocks the deploy. The others do not mean master is bad: 'empty'
// means nothing was built, 'merge_refused' means nothing was merged by that sub-train, and a
// bisect handing branches back leaves whatever already landed perfectly deployable.
const masterIsRed = outcome.stopped === 'master_red_after_merge'
if (masterIsRed) {
  log('master is RED after this merge - NOT deploying, and not closing the issues either')
}

if (landed.length && lastSha && !masterIsRed) {
  if (REPO.deploys) {
    phase('Deploy')
    await agent(deployPrompt(lastSha, landed), { phase: 'Deploy', label: 'deploy' })
  } else {
    log(`${REPO_KEY} has no deploy target - merged to master and stopping there`)
  }

  phase('Close')
  await agent(closePrompt(landed, lastSha), { model: 'sonnet', phase: 'Close', label: 'close' })
}

// SAY WHICH BRANCHES WERE DROPPED, ON THE PULL REQUESTS THEMSELVES. Anything landed in this run
// is gone from the list, because a branch dropped from an early build often goes on a later one
// once whatever it clashed with has merged.
const stranded = [...skipped].filter((n) => !landed.includes(n))
if (stranded.length) {
  await agent(
    `These pull requests on ${SLUG} were dropped from a release train for conflicting with
master, and did NOT land in this run: ${stranded.join(', ')}.

A drop is not a rejection. The train skips a conflicting branch and carries on, and NOTHING
re-queues it - it will be dropped from every future train too, silently, until somebody rebases
it onto master. That is the failure mode this step exists to prevent.

Leave one comment on each, so it is visible on the pull request rather than only in a workflow
result that scrolls away:

  gh pr comment <n> --repo ${SLUG} --body "<say: dropped from the release train for conflicting with master, not rejected; it keeps its label and needs a rebase onto current master before a train can take it>"

DO NOT rebase them, do not remove their labels, and do not close them. One comment each, then
report which numbers you commented on. If a comment fails, say which - an uncommented one is the
case this step is trying to stop.`,
    { model: 'haiku', effort: 'low', phase: 'Close', label: 'strand-notice' },
  )
}

// The holder file lives INSIDE the lock directory, and rmdir refuses a directory that is not
// empty - so removing the lock means removing the holder first. Getting this wrong on
// 2026-08-29 left the lock held after a clean run and the next train stood down against a
// lander that had already finished. Verify rather than report: a lock that is still there
// after this is a leak that blocks every future train until somebody clears it by hand.
const released = await agent(
  `Release the serial merge lock - but only if it is still THIS run's lock.

RELEASE IS CONDITIONAL ON OWNERSHIP, and that is the point of this step rather than a formality.
An unconditional delete of a shared lock is refused, correctly: if another train holds it, removing
it puts two trains on one repository and corrupts merges and deploys to both environments. So prove
the lock is yours by matching the token this run stamped into it:

  EXPECTED='${lock.token || ''}'
  ACTUAL="$(cat /tmp/devloop-merge.lock/holder 2>/dev/null)"
  echo "expected=[$EXPECTED] actual=[$ACTUAL]"

If EXPECTED is empty, or the two do not match exactly, STOP. Do not remove anything. Report status
"leaked" with both values in the notes - a lock held by somebody else, or one this run cannot prove
it owns, must be left alone and surfaced.

If they match exactly, the lock is yours and removing it is safe. The holder file is INSIDE the
lock directory and rmdir refuses a non-empty directory, so remove it first:

  rm -f /tmp/devloop-merge.lock/holder
  rmdir /tmp/devloop-merge.lock

Then PROVE it is gone rather than trusting the exit code:

  ls -d /tmp/devloop-merge.lock 2>/dev/null && echo STILL_THERE || echo GONE

Report status "released" only if that printed GONE. If it printed STILL_THERE, report status
"leaked" and say what ls showed - a lock left behind blocks every future train until it is
cleared by hand, so this must be visible rather than silently reported as done.`,
  { schema: { type: 'object', required: ['status'], properties: {
      status: { type: 'string', enum: ['released', 'leaked'] }, notes: { type: 'string' } } },
    model: 'haiku', effort: 'low', phase: 'Close', label: 'release' },
)

return {
  landed,
  rejected,
  flakes,
  // DROPPED BRANCHES BELONG IN THE RESULT, not only in a comment on the pull request. The strand
  // notice above makes a drop visible to somebody looking at GitHub; the supervisor reads this
  // object. On 2026-08-30 a train returned landed:[748], rejected:[] and notes:null while
  // silently dropping #739 for the same two conflicts it had been dropped for before - which
  // reads as "#739 simply was not ready" rather than "#739 needs a rebase and nothing will do
  // it". An empty rejected list must not be able to hide work that went nowhere.
  stranded,
  mergeSha: lastSha,
  stopped: outcome.stopped || null,
  notes: outcome.notes || null,
  lock: released && released.status === 'released' ? 'released' : 'LEAKED - clear it by hand',
}
