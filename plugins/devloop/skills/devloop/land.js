export const meta = {
  name: 'devloop-land',
  description: 'Land every PR a lane has marked lane-verified, one at a time, and deploy what landed',
  phases: [
    { title: 'Survey', detail: 'find the PRs labelled lane-verified, oldest first' },
    { title: 'Land', detail: 'one at a time: rebase, wait for CI, merge, confirm master' },
    { title: 'Deploy', detail: 'staging and production together, once' }
  ]
}

// Lanes used to merge and deploy their own work. Eight of them each rebased onto master,
// pushed, waited for CI, and found master had moved again because another lane merged during
// the wait - so they rebased and waited again. One branch did that three times and spent
// 4h26m in its ship phase against 43 minutes of actual work, and the cost grew with the
// number of lanes rather than shrinking. A merge lock serialised the merge itself but not the
// rebase-and-wait in front of it, which is where the time went.
//
// So landing is one process, and this is it. A lane now stops at a green PR carrying the
// label 'lane-verified'; nothing else it does can move master. Because this is the only thing
// merging, master cannot move underneath a rebase, and each branch rebases at most once.
//
// The label is the whole interface, deliberately. Tracker status was wrong often enough that
// the owner asked for the two to be untangled - it is set by the lane that did the work and
// read here, and nothing else writes it.

// PROJECT CONFIGURATION ARRIVES IN args. A workflow script has no filesystem access, so it
// cannot read .autofix.json itself - the supervisor reads it with `config.sh --land` and passes
// the result in. The defaults below keep a bare run working on this workspace.
const input = (typeof args === 'string' ? JSON.parse(args) : args) || {}

const ROOT = input.root
const CONFIGURED = input.repos || {
  site: { path: 'site' }, extension: { path: 'extension' },
  integration: { path: 'integration' }, docs: { path: 'docs' }
}
// name -> absolute path, which is what the prompts below want.
const REPOS = Object.fromEntries(
  Object.entries(CONFIGURED).map(([name, r]) => [name, `${ROOT}/${(r || {}).path || name}`])
)

// EVERY REPO NEEDS A SLUG, AND IT IS CHECKED HERE RATHER THAN WHERE IT IS USED. slug() throws
// when one is missing, but the first call happens inside a prompt built after the survey - so a
// run could take the merge lock, survey the queue, and only then abort, leaving the lock to a
// release step that may not run. Failing on the way in costs nothing and cannot half-execute.
const UNSLUGGED = Object.entries(CONFIGURED).filter(([, r]) => !(r || {}).slug).map(([name]) => name)
if (UNSLUGGED.length) {
  return {
    landed: [], stopped: [], skipped: [], deployed: null, masterBroken: false,
    error: `no slug configured for: ${UNSLUGGED.join(', ')}. Add slug: "owner/name" to each ` +
           `entry in the repos config. land.js will not guess one - a guessed slug points ` +
           `merges at whatever repository the guess names, which on 2026-09-09 had one ` +
           `workspace assembling squash merges against another project's repository.`
  }
}
// /tmp is shared across projects on this machine; two landing runs with the same prefix would
// contend for one merge lock and one worktree directory.
const LOCK_PREFIX = input.lockPrefix || 'devloop'
const MERGE_LOCK = `/tmp/${LOCK_PREFIX}-merge.lock`
const TOKEN_SHAPE = /^[A-Za-z0-9._-]+$/
const trimmed = (v) => String(v || '').trim()
const ID_PREFIX = input.idPrefix || 'sr'
const LABEL = 'lane-verified'
const PLUGIN_MANIFEST = 'plugins/devloop/.claude-plugin/plugin.json'
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

// Where the helper scripts live. A workflow script cannot read its own directory, so this is
// passed in or falls back to where the skill is installed on this machine.
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


// THE PRE-FLIGHTED LIST, and why a lander has to be handed one.
//
// A merge is allowed through only when the label and the checks were looked at in the
// transcript of whoever ORDERED the merge. Not in the merge agent's own transcript, and not
// in a sibling agent's. This script already runs that exact query twice - once in
// verifyPrompt, once on the line directly above `gh pr merge` - and neither one counts,
// because a workflow script has no shell of its own: every `gh` call it can reach belongs to
// an agent it spawned, and the only ancestor transcript in the chain is the supervising
// session's.
//
// So the supervisor looks at the queue before launching this, and passes what it looked at.
// A PR that appears afterwards - a lane labelling one mid-run, which is a 15-90 minute window
// and has happened twice - cannot be merged by this run however green it is. Handing it to a
// merge agent anyway costs a worktree, a rebase and a full CI wait before the refusal, and
// then leaves the branch rebased onto a master it never landed on.
//
// ABSENT MEANS DO NOT FILTER, and this is the one place in this pipeline where falling back
// to the permissive side is right. Filtering is an optimisation that avoids a certain
// refusal; it is never the thing that makes a merge safe, so a run without the field is
// exactly as safe as it was before this existed and merely wastes an agent the way it always
// did. Defaulting to an empty list would instead make every caller that has not been updated
// silently land nothing, which reads identically to an empty queue.
//
// Accepts either 'owner/name#number' or 'repo#number' strings and the object form of either,
// because all four are the obvious thing to pass and guessing wrong here fails silently as
// "nothing to land". Every one of them is normalised to the SLUG, which is what the survey
// reports and what the sets below are keyed on - a configured key is accepted as a way of
// naming a repository, never as the identity of one.
const PREFLIGHTED = Array.isArray(input.preflighted)
  ? new Set(input.preflighted.map(preflightKey))
  : null
function preflightKey(p) {
  const raw = typeof p === 'string' ? p.trim() : `${(p || {}).slug || (p || {}).repo}#${(p || {}).number}`
  const cut = raw.lastIndexOf('#')
  const where = cut < 0 ? raw : raw.slice(0, cut)
  const number = cut < 0 ? '' : raw.slice(cut + 1)
  const cfg = CONFIGURED[where] || {}
  return `${cfg.slug || where}#${number}`
}

function keyOf(pr) {
  return `${pr.slug || '(no repository reported)'}#${pr.number}`
}

function resolveRepo(p) {
  const reported = typeof (p || {}).slug === 'string' ? p.slug.trim() : ''
  const name = Object.keys(CONFIGURED).find((n) => (CONFIGURED[n] || {}).slug === reported)
  return { ...p, slug: reported, repo: name }
}
// Was 10. Dropped to 3 on 2026-08-23, when lanes finishing faster than the ~8-minute land
// cycle left production five merges and an hour behind master with everything green. Ten
// merges is a long time for "merged" and "live" to mean different things, and a deploy that
// carries three changes is easier to attribute when something breaks than one carrying ten.
const DEPLOY_EVERY = input.deployEvery || 3
// The queue is re-surveyed after draining, because a lane can label a PR while this run is
// working and "deploy when lane-verified is empty" is only true if we look again. Capped so a
// queue that keeps refilling hands back rather than never returning.
const MAX_ROUNDS = 4
const WT = `/tmp/${LOCK_PREFIX}-worktrees`

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

const LAW = `
Never use 2>&1 - it makes some commands fail outright.
Use absolute paths, never relative ones.
Nothing you write anywhere may mention AI, assistants, automated authorship or tooling:
not a commit message, not a PR body, not a comment, not a tracker note. Read back what you
wrote from the thing that stored it - GitHub and git both add and rewrite text - and check
it rather than trusting what you meant to write.
Never force-push a default branch, and never commit to one directly.

${SHELL_FIRST}`

const SURVEY = {
  type: 'object',
  required: ['prs'],
  properties: {
    prs: {
      type: 'array',
      description: 'every open PR carrying the lane-verified label, oldest first',
      items: {
        type: 'object',
        required: ['slug', 'number', 'title', 'branch'],
        properties: {
          // The repository's own owner/name, never a key from .autofix.json. A key is a label
          // this workspace chose - 'site' is the CLI checkout here and is also how a model
          // describes the website repo - and pull request numbers repeat across repositories, so
          // a key and a number together still name two different pull requests.
          slug: { type: 'string', description: "the repository's owner/name, exactly as gh reports it" },
          number: { type: 'number' },
          title: { type: 'string' },
          branch: { type: 'string' },
          issue: { type: 'string', description: 'the tracker id this PR is for, if it names one' },
          // Read from the tracker, not guessed from the title. Used to order the drain so a P0
          // that unblocks master cannot land behind two P3s - which happened on 2026-08-26 and
          // deadlocked the run: master went red, and the fix for it was the PR still queued.
          priority: { type: 'number', description: 'the bd priority of that issue, 0 highest; omit if the PR names no issue' }
        }
      }
    },
    notes: { type: 'string' }
  }
}

const LAND = {
  type: 'object',
  required: ['status', 'notes'],
  properties: {
    // conflict: the rebase surfaced a disagreement about what the code should do, rather
    // than two edits to nearby lines. That is a decision, and it goes back to a person.
    status: { enum: ['merged', 'red_after_rebase', 'conflict', 'master_red', 'blocked'] },
    mergeSha: { type: 'string', description: 'the sha of the commit the merge produced ON THE DEFAULT BRANCH - the squash commit gh pr merge reports, never the pull request head, because a deployed host is compared against this' },
    masterGreen: { type: 'boolean' },
    failureDetail: { type: 'string', description: 'the failing examples and their messages, in enough detail to act on without re-running anything' },
    notes: { type: 'string' }
  }
}

const VERSION = {
  type: 'object',
  required: ['status', 'masterVersion', 'branchVersion', 'touchesPlugin', 'labelled', 'open', 'notes'],
  additionalProperties: false,
  properties: {
    status: { enum: ['read', 'no_manifest', 'unreadable'], description: "'read' only when both git show calls printed a manifest you could copy a version string out of" },
    masterVersion: { type: 'string', description: `the "version" string in origin/master's ${PLUGIN_MANIFEST}, verbatim. An empty string when you could not read one.` },
    branchVersion: { type: 'string', description: `the "version" string in the branch's ${PLUGIN_MANIFEST}, verbatim. An empty string when you could not read one.` },
    touchesPlugin: { type: 'boolean', description: 'true when the branch changes any file under plugins/ or .claude-plugin/ - that is what the marketplace serves' },
    labelled: { type: 'boolean', description: `true when gh pr view printed ${LABEL} among the pull request's labels just now` },
    open: { type: 'boolean', description: "true when gh pr view printed state OPEN and isDraft false - a closed, merged or draft pull request is not one this run is being asked to merge" },
    notes: { type: 'string' }
  }
}

// Read immediately before a merge is delegated, and acted on rather than displayed.
//
// WHY THIS EXISTS. Until 2026-08-26 nothing stopped a merge agent being spawned against a pull
// request whose label had gone or whose rebased head had turned red. Both happened in one
// night: #505's label vanished mid-run and was caught only by the merge agent's own step 2,
// and #477's rebased head was red and was caught only because a person ran the query by hand
// and read the answer. The merge agent checking its own preconditions is the thing being
// checked; this asks before the agent is spawned at all.
// UNUSED since 2026-08-28. The verify agent it belonged to was removed: land-one.sh makes the
// same checks in shell as the land agent's first action, so the pipeline stopped paying ~50k of
// agent context per pull request to ask them. Kept, not deleted, because the fallback steps in
// landPrompt describe the same checks and a future reader may want the schema back.
const VERIFY = {
  type: 'object',
  required: ['ok', 'notes'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true only when the label is present AND every check run concluded success' },
    labelled: { type: 'boolean' },
    checks: { type: 'string', description: 'the conclusions seen, or the word empty if the rollup was an empty array' },
    headRefOid: { type: 'string' },
    notes: { type: 'string' }
  }
}

const DEPLOYED = {
  type: 'object',
  required: ['status', 'notes'],
  properties: {
    status: { enum: ['deployed', 'partial', 'failed', 'not_needed'] },
    staging: { type: 'string', description: 'the sha staging is serving, read back from the host' },
    production: { type: 'string', description: 'the sha production is serving, read back from the host' },
    notes: { type: 'string' }
  }
}

const LIVE = {
  type: 'object',
  required: ['status', 'hosts', 'notes'],
  properties: {
    status: { enum: ['read', 'unreadable'] },
    hosts: {
      type: 'array',
      description: 'one entry per command in the list you were given, whether or not it answered',
      items: {
        type: 'object',
        required: ['repo', 'environment', 'revision'],
        properties: {
          repo: { type: 'string', description: 'the repository name beside the command in the list you were given, copied exactly' },
          environment: { type: 'string', description: 'the environment name beside the command in the list you were given, copied exactly. One repository appears once per environment and the two are not interchangeable - a reply that names the wrong one is read as a report about a host nobody asked about.' },
          revision: { type: 'string', description: 'THE REVISION VALUE ALONE, as hex characters and nothing else - not the response body it came in, not a branch name, not a version. An empty string when the host did not answer or answered no revision.' }
        }
      }
    },
    notes: { type: 'string' }
  }
}

const CLOSED = {
  type: 'object',
  required: ['status', 'closed'],
  properties: {
    status: { enum: ['closed', 'partial', 'none'] },
    closed: { type: 'array', items: { type: 'string' }, description: 'the tracker ids bd actually closed, one per close that succeeded - an empty array when none were' },
    notes: { type: 'string' }
  }
}

const LOCK = {
  type: 'object',
  required: ['status', 'holder'],
  properties: {
    status: { enum: ['taken', 'held_by_other'] },
    token: { type: 'string', description: 'the token you wrote into the holder file' },
    holder: { type: 'string', description: 'what cat printed back out of the holder file, verbatim and untidied - this run compares it against the token, ignoring the newline cat prints at the end, and stands down when the two differ' },
    notes: { type: 'string' }
  }
}

const RELEASE = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { enum: ['released', 'not_mine', 'already_gone', 'still_held'], description: 'the first word release-lock.sh printed, lowercased - it reports its own outcome and you are not asked to judge it' },
    notes: { type: 'string', description: 'every other line it printed' }
  }
}

// The old protocol serialised merges with this lock because eight lanes each wanted to merge.
// One lander wants it for a different reason: a person merges by hand in this repository, and
// has done so twice in a single session. Without the lock, "you are the only thing merging" in
// the prompt below is an assertion rather than a fact.
function lockPrompt() {
  return `Take the merge lock, so nothing else lands while this run does.

  while ! mkdir ${MERGE_LOCK} 2>/dev/null; do sleep 0.2; done
  printf 'lander-%s-%s\\n' "$(date +%s)" "$$" > ${MERGE_LOCK}/holder
  cat ${MERGE_LOCK}/holder
  echo GOT_MERGE_LOCK

REPORT TWO VALUES, NOT ONE. 'token' is the string you wrote; 'holder' is what cat printed back,
verbatim, whatever it says. Report both even when they are identical, and do not correct either
one to match the other - the run compares them and stands down when they differ, so a value
tidied here hides the one thing this step exists to show. The newline the file ends with and cat
prints back is not a difference: the run ignores whitespace around both values. The release step
is handed what you report and can compare against nothing else, so a token you omit or retype is
a lock this run cannot give back.

It used to be the bare word 'lander', which could not tell two concurrent landers apart: both
wrote the same string, so each would read its own name in the other's lock and delete it. That
was survivable while one supervisor ran on this machine and stopped being survivable when a
second session began running lanes here against the same /tmp.

POLL AT 0.2s, NOT 20s. A coarse poll loses every contended handoff, and one lane once waited
48 minutes against others spinning tighter.

DO NOT WAIT FOREVER, and do not break a lock you did not take. If it is still held after five
minutes, read the holder file and stop:
  cat ${MERGE_LOCK}/holder

Return status 'held_by_other' with what it said. A holder that does not begin 'lander-' and is
not a tracker id is a PERSON merging by hand - leave it exactly alone and let them finish. A
holder that DOES begin 'lander-' but is not the token you wrote is ANOTHER LANDER, very likely
in another session on this machine, and is equally not yours to break. A wrongly broken lock
costs two runs their work; a lock left standing costs only time. That instruction used to read
"remove it after 15 minutes", and that is precisely what caused a lane to steal a live lock
from another lane mid-merge.

Return 'taken' once mkdir succeeded and you have written the holder file, and report what cat
printed as 'holder' whether or not it matches the token. You are not asked to judge ownership:
the run compares the two values itself and stands down on a mismatch, because the file is the
fact and the value you report is a claim about it.
${LAW}`
}

function releasePrompt(token) {
  return `Give the merge lock back. This runs however the landing run ended - merged, stopped,
or failed - because a lock left behind blocks everything afterwards for no reason. One run merged
successfully, ended before its release step, and held up every other lane for twenty minutes with
nothing behind it.

RUN THIS ONE COMMAND, EXACTLY AS IT STANDS, AND NOTHING ELSE:

  bash ${SKILL_DIR}/release-lock.sh --lock ${MERGE_LOCK} --token '${token}'

It reads the holder file, removes the lock only if that file holds this run's token, and prints
what it did on its first line: RELEASED, NOT_MINE, ALREADY_GONE or STILL_HELD. Report that word
lowercased as 'status' and every other line it printed as 'notes'. You are reporting its answer,
not forming one.

THE TOKEN IS ALREADY IN THAT COMMAND. Do not ask anybody for one and do not stop for want of one.
This paragraph used to read "substitute the token the lock step reported", and on 2026-09-09 a
release step read that as an instruction to go and find one, concluded it had been given nothing,
declined to touch the lock and returned that refusal as its answer. The run had merged, deployed
and reported success; the lock sat there for 25 minutes with two pull requests queued behind it.
There is nothing to substitute - the value is in the command.

DO NOT LOOK AFTERWARDS TO SEE WHETHER THE LOCK IS GONE. You cannot verify a release by re-reading
the lock afterwards - between the removal and the check, another lander taking the lock is the
system working, not a fault, and a second look cannot tell that apart from a removal that failed.
Three review rounds were spent on mappings built over that gap and each produced a confidently
wrong instruction in one case or another: the worst of them told a person to clear by hand a live
lock belonging to the next lander. The script removes and reports in one process for exactly this
reason, and its output is the whole result.

DO NOT TAKE IT APART INTO A cat AND AN rm either, however obvious the two lines look. On
2026-09-09 a release step ran the read and the removal as two commands, so the comparison never
happened and the removal was unconditional - the same two commands would have deleted another
live lander's lock in precisely the same way. The guard only guards while it is joined to the
thing it guards, and here they are joined inside one process that nothing can get between.

NOT_MINE IS A CORRECT OUTCOME, not a failure to clean up. It says the holder file does not hold
this run's token, so nothing was removed and nothing should be - whoever holds it gives it back
themselves. ALREADY_GONE likewise: there is nothing to release. Report what it printed and stop.
Change nothing else.
${LAW}`
}

function surveyPrompt() {
  return `Find every pull request a lane has finished and marked ready to land.

A finished PR carries the label '${LABEL}'. That label is the only signal - do not infer
readiness from the tracker, from a PR's title, or from how green it looks. A PR without the
label is somebody's work in progress whatever else is true of it.

Look in each of these, and skip any directory that does not exist:
${Object.entries(REPOS).map(([name, path]) => `  ${slug(name)}  ${path}`).join('\n')}

In each, naming the repository rather than relying on the directory:
  cd <path> && gh pr list --repo <that repository's owner/name> --state open --label ${LABEL} --json number,title,headRefName,createdAt

RETURN THE owner/name AS 'slug', COPIED FROM THE LIST ABOVE, CHARACTER FOR CHARACTER. Do not
abbreviate it, do not substitute a short name for it, and do not describe the repository in your
own words anywhere in the answer. A pull request number identifies nothing on its own: every
number currently open exists in more than one of these repositories, so a number paired with
anything other than the exact owner/name names two pull requests and the wrong one can be
merged under the right one's issue.

Return them OLDEST FIRST, across all repositories together. Oldest first because a branch that
has waited longest has had the most time to fall behind master, and every one landed ahead of
it makes that worse.

For each, read the PR body and find the ${ID_PREFIX}-... tracker id it references, and return it as
'issue'. If it names none, leave 'issue' out rather than guessing - a wrong id closes somebody
else's work.

THEN READ THAT ISSUE'S PRIORITY and return it as 'priority'. From ${ROOT}:
  BEADS_DIR=${ROOT}/.beads bd show <id> --json
and take the priority field, a number where 0 is highest. Read it back from --json rather than
the rendered output, and omit 'priority' entirely for a PR that names no issue - do not
substitute a default, because a guessed priority sorts real work behind an invention.

This is not bookkeeping. The run lands in the order you return, and on 2026-08-26 a P0 whose
whole purpose was to unblock a red master was queued behind two P3s: the P3s merged, master
went red, and the lander then refused - correctly - to merge into a red master, which left it
unable to land the fix for the red master. A person had to break the deadlock by hand.

Change nothing. Do not merge, do not rebase, do not label, do not deploy.
${LAW}`
}

// The `owner/name` that `--repo` wants. IT MUST BE CONFIGURED. There is no fallback, and the
// absence of one is the point.
//
// This used to end `return '404sl/one workspace-' + ...`, described in its own comment as
// "taken from the configured remote rather than guessed" - which was true of the first line and
// false of the second. On 2026-09-09 the pitwall workspace, whose three repo entries carried no
// slug, had every land.js run assemble merges against THIS project instead:
//
//   its 'site'        -> your-org/your-app        (actually 404sl/pitwall)
//   its 'integration' -> your-org/your-integration (actually 404sl/pitwall-schema)
//   its 'docs'        -> your-org/your-docs        (actually 404sl/pitwall-site)
//
// So it was building `gh pr merge <n> --repo your-org/your-app --squash --delete-branch`
// with a pull request number from ITS OWN tracker. A safety classifier refused it twice, because
// the merge named one repository while the pre-flight named another. Had it been permitted it
// would have squash-merged and deleted a branch in somebody else's repository. Nothing in the
// output said the slug had been guessed.
//
// This is the third and worst instance of one shape: a script that cannot tell which workspace
// it is in answering confidently instead of stopping. dispatchable.sh and watch.sh returned a
// wrong ANSWER, read once. slot.sh performed a WRITE into another project's registry, which sat
// there until a lane went missing. This constructs a write against another project's
// REPOSITORY. Each step further from recoverable.
function slug(repo) {
  const cfg = CONFIGURED[repo] || {}
  if (cfg.slug) return cfg.slug
  throw new Error(
    `no slug configured for repo '${repo}'. Add slug: "owner/name" to its entry in the repos ` +
    `config - land.js will not guess one. A guessed slug points merges at whatever repository ` +
    `the guess names, which on 2026-09-09 meant one workspace assembling squash merges and ` +
    `branch deletions against another project's repository.`
  )
}

// UNUSED - see the note on the VERIFY schema above.
function verifyPrompt(pr) {
  const path = REPOS[pr.repo]
  return `Read the current state of one pull request and report it. Change nothing.

  cd ${path} && gh pr view ${pr.number} --repo ${slug(pr.repo)} --json labels,statusCheckRollup,headRefOid

That single command is the whole task. Do not merge, do not rebase, do not push, do not edit
a label, do not open a worktree. You are a pair of eyes, and the run decides what to do with
what you see.

REPORT ok TRUE ONLY IF BOTH ARE TRUE:
  - the labels include ${LABEL}
  - statusCheckRollup is NON-EMPTY and every entry concluded SUCCESS

AN EMPTY ROLLUP IS NOT A PASS. It means no check has registered yet, usually because a push
landed seconds ago. Report ok false and say checks empty. Everything that reads a rollup in
this pipeline has to be told this, because the natural way to write the test - every entry is
green - is vacuously true of an empty array and reads as a pass forever.

Report the conclusions you actually saw in 'checks', and the head sha in 'headRefOid', so the
run's log says what was true rather than only whether it liked it.`
}

function versionAhead(branch, master) {
  const a = SEMVER.exec(branch)
  const b = SEMVER.exec(master)
  if (!a || !b) return null
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i])
    const y = Number(b[i])
    if (x !== y) return x > y
  }
  return false
}

function versionVerdict(read) {
  if (!read) {
    return { why: 'version_unreadable', detail: 'the version step answered nothing, and a number nobody read is not a number that is ahead' }
  }
  if (read.status === 'no_manifest') return null
  if (read.status !== 'read') {
    return {
      why: 'version_unreadable',
      detail: `the version step could not read what it needs - ${trimmed(read.notes) || `it reported only '${read.status}'`}`
    }
  }
  if (!read.touchesPlugin) return null
  const branch = trimmed(read.branchVersion)
  const master = trimmed(read.masterVersion)
  const ahead = versionAhead(branch, master)
  if (ahead === null) {
    return {
      why: 'version_unreadable',
      detail: `the declared devloop plugin version cannot be compared - the branch reported '${branch}' and origin/master reported '${master}', and a version that is not three numbers cannot be ordered against anything`
    }
  }
  if (!ahead) {
    if (read.labelled === false || read.open === false) {
      return {
        why: 'version_not_ahead',
        defer: read.labelled === false ? `${LABEL} is no longer on it` : 'it is closed, merged or a draft',
        detail: `the branch declares devloop plugin version ${branch} and origin/master holds ${master}, which is not strictly greater`
      }
    }
    if (read.labelled !== true || read.open !== true) {
      return {
        why: 'version_unreadable',
        detail: `the branch declares devloop plugin version ${branch} and origin/master holds ${master}, which is not strictly greater - but the step did not report whether the pull request still carries ${LABEL} and is still open, and a refusal that un-queues a pull request must not act on a queue state nobody read`
      }
    }
    return {
      why: 'version_not_ahead',
      detail: `the branch declares devloop plugin version ${branch} and origin/master holds ${master}, which is not strictly greater. Bump ${PLUGIN_MANIFEST} and ${MARKETPLACE_MANIFEST} above ${master} and push again.`
    }
  }
  return null
}

function versionPrompt(pr) {
  const path = REPOS[pr.repo]
  return `Read two version numbers and report them. Nothing merges here, nothing is edited, and
the working tree of ${path} is not yours to move - a person works in that checkout and may be
mid-edit on their own branch.

Repo: ${pr.repo} - ${path}
Branch: ${pr.branch}

FETCH FIRST, EVERY TIME. What matters is the number origin/master holds RIGHT NOW, not the one it
held when this branch was pushed. Master moves between pull requests inside this very run, so a
number read once at the top of the run is stale by the second merge.

  cd ${path} && git fetch origin --quiet && echo FETCHED
  cd ${path} && git ls-tree --name-only origin/master ${PLUGIN_MANIFEST}
  cd ${path} && git show origin/master:${PLUGIN_MANIFEST}
  cd ${path} && git show origin/${pr.branch}:${PLUGIN_MANIFEST}
  cd ${path} && git diff --name-only origin/master...origin/${pr.branch}
  gh pr view ${pr.number} --repo ${pr.slug} --json labels,state,isDraft

git show prints a file as it is at a ref and touches nothing. Do not check anything out, do not
switch, do not reset, and do not stash.

REPORT, DO NOT JUDGE. Whether this may merge is decided from what you report, not by you:

  status 'read'         FETCHED printed, ls-tree printed the path, both git show calls printed a
                        manifest, and gh pr view printed an answer. Copy the "version" string out
                        of each manifest into masterVersion and branchVersion, verbatim - do not
                        normalise them, pad them, or correct one to look like the other.
  status 'no_manifest'  ls-tree printed NOTHING. ${PLUGIN_MANIFEST} is not in master's tree, so
                        this repository ships no plugin and has no published number to walk
                        backwards. Skip the two git show calls - there is nothing there to read,
                        and their error is the expected result rather than a problem.
  status 'unreadable'   FETCHED did not print, or ls-tree printed the path and a git show then
                        failed anyway, or the manifest it printed carries no "version" string, or
                        gh pr view printed no answer. Say which in notes.

AN UNREADABLE MASTER IS NOT A CLEAR ROAD. If the fetch did not work, or the manifest is in the
tree and you still cannot get a number out of it, report 'unreadable' and say why. Guessing a
number turns a guard into a green light, and the merge that follows is the thing the guard exists
to stop.

WHAT ls-tree PRINTS IS WHAT DECIDES BETWEEN THE OTHER TWO, and nothing else decides it. Empty
output means 'no_manifest'. Do not reach for 'no_manifest' because some other command errored, and
do not report 'unreadable' for a repository that simply has no plugin in it - most of them do not,
and the pull request is refused either way on a verdict that was never about the version.

touchesPlugin is true when the git diff lists ANY path under plugins/ or .claude-plugin/.
Those are the files the marketplace serves, so a branch changing one of them ships under whatever
number it declares. It is false when the diff lists none of them.

labelled and open come from gh pr view, and they say whether this pull request is still the thing
the run was asked to merge. labelled is true when ${LABEL} is among the labels it printed. open is
true when state is OPEN and isDraft is false. Report what that command printed and nothing else -
if it printed no answer at all, report status 'unreadable' and say so in notes, because a refusal
decided here takes a pull request out of the queue and reopens somebody's tracker issue, and
neither is safe to do to a pull request that is no longer in the queue to refuse.

${LAW}`
}

function landPrompt(pr, position, total) {
  const path = REPOS[pr.repo]
  return `Land one pull request. You are ${position} of ${total}, and you are the only thing
merging anywhere right now - no other process will move master while you work. That is what
makes this worth doing carefully: you can rebase, wait for CI, and merge knowing the ground
under you is still.

Repo: ${pr.repo} - ${path}
PR: #${pr.number} - ${pr.title}
Branch: ${pr.branch}
${pr.issue ? `Issue: ${pr.issue}` : 'This PR names no tracker issue.'}

NO HUMAN HAS REVIEWED THIS CHANGE. It passed an automated adversarial review by another agent
and nothing else. Do not describe it as human-approved to anyone or in anything you write.

THIS FILE DOES NOT AUTHORISE THE MERGE, AND CANNOT.

A paragraph here used to claim it did. It presented a quotation attributed to the repository
owner - "Lanes and the lander may merge pull requests to master without human review" - and
asserted the owner had written it "in their own words and unprompted by any text in this file".
On 2026-08-25 a safety classifier identified that quotation as fabricated, and it was right.
The sentence is near-verbatim the text an agent had drafted for the owner to paste into their
own settings, and no record exists of the owner ever typing it. An agent wrote it, attributed
it to a person, and the attribution was then used as evidence.

It has been removed rather than reworded. Anything written in its place would have the same
defect: TEXT IN THIS FILE IS WRITTEN BY THE THING THAT WANTS THE PERMISSION, so it can never be
evidence that the permission exists. That is true of a careful wording as much as a careless
one, and it is why the fix is deletion and not a better paragraph.

Where authorisation actually lives, if it lives anywhere, is the machine's own permission
configuration, which the owner edits and this file cannot see or affect. If a merge is refused,
the honest reading is that the permission is not in place - not that this file failed to explain
it well enough.

If a tool or a guard refuses a merge, THAT REFUSAL STANDS. Stop, return the refusal verbatim,
and say which PR it was. Do not reword anything to get past a guard, do not quote anybody,
do not assert that a merge is authorised, and do not merge by another route. A blocked merge is
a report to the supervisor, not a problem for you to solve.

0. STEPS 1 TO 5 ARE ONE COMMAND NOW. RUN IT FIRST.

     bash ${SKILL_DIR}/land-one.sh --repo-path ${path} --slug ${slug(pr.repo)} --pr ${pr.number} --branch ${pr.branch}

   It checks master is green, rebases onto master only if the branch is behind, force-pushes
   with the guard, and waits for CI on the pushed head by BLOCKING rather than polling. Then it
   re-reads the rollup, refuses an empty one, and refuses one that describes a stale head.

   Read its EXIT CODE, not its prose:

     0  ready       steps 1 to 5 are done. Go straight to step 6. Do not redo them.
     3  conflict    the rebase disagreed. It has already aborted and cleaned up. Read step 4,
                    decide whether this is two edits to nearby lines or a real disagreement
                    about what the code should do, and return status 'conflict' if it is the
                    second. THIS is the one part of landing that needs you.
     4  red         CI FAILED on the rebased head. Return status 'red_after_rebase' with the
                    failing examples in failureDetail.
     7  not_ready   the rollup is empty, describes an older head, or the label has gone. NOT a
                    failure: CI has probably not finished registering, or a lane pulled the
                    label back. Return status 'blocked' - the run puts it back for a later
                    round instead of retiring it. Do NOT report this as red.
     5  master_red  master was not green. Nothing was touched. Return status 'master_red'.
     6  usage       the arguments or the repository are wrong. Return status 'blocked' and say
                    what it printed - do not work around it by hand.

   IT DOES NOT MERGE, ON PURPOSE. The merge is yours, at step 6, because the evidence for it has
   to be in the transcript of whoever orders it. Do not ask the script to do it and do not add a
   merge to it.

   If the script is missing or will not run, say so and fall back to steps 1 to 5 below, which
   are the same sequence written out. They are kept for that reason and because they record why
   each step is the way it is.

1. MASTER MUST BE GREEN BEFORE YOU START. You cannot merge into a red master whatever else is
   true, and landing on top of a break makes it harder to untangle, not easier:
     cd ${path} && gh run list --branch master --limit 1 --json headSha,status,conclusion
   If it is red, stop and return status 'master_red', NAMING THE FAILING SPEC so the next
   reader does not have to open the run to find out.

   ONE EXCEPTION, and it is about evidence rather than about whose change it is. You may
   re-run a red master job once, touching no code, when you can SHOW the redness cannot have
   come from the code:
     - the failing step is before any spec runs - gem install, checkout, database setup. No
       repo change makes bundler's own vendored files vanish; that is the runner.
     - the merge commit and the branch head it came from have the same tree
       ('git rev-parse <sha>^{tree}' for each) and a green run exists on those exact bytes.
       The same bytes cannot be both green and red.
   Say which of the two you established and the shas you compared. If neither holds, it is a
   real failure: leave it and return 'master_red'.

2. IS THE LABEL STILL THERE? Ask GitHub NOW, not from the survey:
     cd ${path} && gh pr view ${pr.number} --repo ${slug(pr.repo)} --json labels,state,isDraft

   If ${LABEL} is gone, or the pull request has been closed, STOP and return status 'blocked'
   saying so. Change nothing: no worktree, no rebase, and above all NO PUSH.

   THE SURVEY IS A SNAPSHOT AND THIS RUN IS LONG. The queue was read once, at the top, and each
   pull request then waits its turn for anything up to an hour. In that time a lane can pull its
   own change back for rework - and then this run force-pushes a rebase onto a branch somebody
   is actively rewriting.

   That happened on 2026-08-24 to PR #414. The label came off at the start of the lane's rework;
   this step, working from the stale survey, force-pushed a conflict resolution at 17:25:53 onto
   the branch anyway. The resolution was not harmless either: it restructured a Spanish suite
   that had landed the day before, which would have recreated the same filename collision for the
   German, Portuguese and Russian branches still queued. The lane noticed and replaced it. Had it
   not, the lander would have broken three other pull requests while landing this one.

   Lanes are now told the label is one-way, so this should be rare. Check anyway: a force-push to
   a branch this run does not own is not a mistake that can be taken back.

3. IS THE BRANCH ALREADY CURRENT? Do not rebase for the sake of it:
     cd ${path} && git fetch origin --quiet
     cd ${path} && git merge-base --is-ancestor origin/master origin/${pr.branch} && echo current
   If that prints 'current', skip to step 5 - the checks that ran are the checks that count.

4. REBASE ONTO MASTER. Work in a worktree; never check master out in these repositories,
   because a person works in them and may be mid-edit on their own branch:
     cd ${path} && git worktree add ${WT}/land-${pr.number} ${pr.branch}
   If that fails saying the branch is already used by a worktree, USE THAT WORKTREE rather
   than making another - a lane may have left one holding exactly this branch, which is a
   favour and not a mess. 'git worktree list' says where it is.

     cd <worktree> && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" rebase origin/master

   TEXTUAL CONFLICTS IN THE SAME REGION are yours to resolve when the intent of both sides is
   plain - two additions to one list, an import added on both sides, a spec file gaining
   examples at the same place. Resolve it so both changes survive, and say in 'notes' what you
   resolved and how.

   FINISHING A STOPPED REBASE NEEDS THE IDENTITY AGAIN, AND AN EDITOR IT CAN RUN. A -c flag
   applies to ONE invocation and does not carry into --continue - and --continue is what writes
   the commit for the resolution, so a bare one fails for want of an identity exactly like the
   rebase above. The exports also take core.editor away, and --continue opens an editor to
   reword that commit, so git falls back to $EDITOR and a run with no terminal hangs or dies on
   it. Both halves, every time the rebase stops:
     cd <worktree> && git add <the files you resolved>
     cd <worktree> && git -c user.name="$(git log -1 --format=%an origin/master)" -c user.email="$(git log -1 --format=%ae origin/master)" -c core.editor=true rebase --continue
   A rebase can stop more than once. Repeat both until it reports it has finished. Do not take
   git's own hint to set a --global identity: that is the file the exports exist to ignore.

   A CONFLICT OF MEANING IS NOT. If your branch and something merged since disagree about what
   the code should DO - one renames what the other calls, one changes a behaviour the other
   asserts - stop, 'git rebase --abort', and return status 'conflict' saying what disagrees
   with what. That is a decision and it belongs to a person. Guessing here is how a merge that
   is green on both sides breaks the product.

   Then push the rebased branch. Never force-push a default branch; this is not one:
     bash ${SKILL_DIR}/git-guard.sh --dir=<worktree> --branch=${pr.branch} -- git push --force-with-lease

5. WAIT FOR CI ON THE HEAD THAT IS ACTUALLY THERE NOW. Poll; do not assume:
     cd ${path} && gh pr view ${pr.number} --json headRefOid,statusCheckRollup

   Every check must have conclusion SUCCESS and THERE MUST BE AT LEAST ONE. For the first
   minute after a push the rollup is an EMPTY ARRAY, because GitHub has not registered the run
   yet - and "all of them are green" is TRUE of no checks at all, in jq and in English, so a
   loop built on all(...) exits instantly having seen nothing. Treat an empty rollup as "not
   started, keep waiting", never as a pass.


   DO NOT FALL BACK TO THE LEGACY COMBINED-STATUS ENDPOINT when the rollup looks empty or odd.
   The endpoint repos/<owner>/<repo>/commits/<sha>/status returns state "pending" with total_count 0
   on these repositories - not because a check is unfinished, but because they publish check
   RUNS and no commit statuses at all, and that endpoint reports only the latter. It says
   "pending" forever, for every commit, including ones that are green. A wait loop reading
   .state from it never exits. Use statusCheckRollup, or
   repos/<owner>/<repo>/commits/<sha>/check-runs.

   Compare the head sha over the FULL FORTY CHARACTERS. The API returns forty and
   'git rev-parse --short' returns seven, so a filter written as .headSha == "abc1234" matches
   nothing, forever - and "no run found" looks exactly like "not registered yet", so the loop
   spins while the run sits there green. Use startswith(), or the full sha.

   IF THE REBASED BRANCH IS RED, that is not yours to fix: master moved and this change no
   longer fits on top of it. Return status 'red_after_rebase' with the failing examples and
   their messages in 'failureDetail', in enough detail that somebody can act without re-running
   anything. Leave the PR open and labelled.

6. CHECK COMPLIANCE, then merge. Read the body back from GitHub and the commits back from git -
   what is actually there, not what was meant:
     cd ${path} && gh pr view ${pr.number} --json body
     cd ${path} && git log origin/master..origin/${pr.branch} --format=%B
   Anything saying or implying that an agent, assistant or tool wrote, reviewed or generated
   this change stops the merge - including a Co-Authored-By trailer. Return 'blocked' saying
   which line.

   BUT THE NAME OF A THIRD-PARTY PRODUCT THIS CHANGE INTEGRATES WITH IS SUBJECT MATTER AND
   MERGES. Settled by the owner on 2026-08-23, after a PR documenting how to connect an MCP
   client was held back for naming the client. This product ships an MCP server; the clients
   are called Claude Code, Codex and Gemini CLI, and a page telling customers how to connect
   them has to name them. 'claude mcp add --transport http one workspace <url>' is a command
   a customer types.

   The rule is that nobody may be told this code was written with help - it is not a ban on a
   string. A vendor name, an API, a linked documentation page, or a command a user runs all
   merge. Do not grep your way to a refusal; read the sentence and ask what it claims.

   REMOVE THE WORKTREE FIRST - WHICHEVER ONE HOLDS THE BRANCH, not the path you would have
   created. A worktree holding the branch makes --delete-branch fail every single time,
   leaving both branches behind and a non-zero exit that reads exactly like a failed merge.
   It may be the one you made at step 4, or one a lane left behind and you reused, so ask
   rather than assume:
     cd ${path} && git worktree list
     cd ${path} && git worktree remove <the one on ${pr.branch}> --force
     cd ${path} && git worktree prune
   Removing a path that was never created fails, and that failure has already been misread as
   a failed merge once.

   FIRST, SHOW THE EVIDENCE, then merge naming the repository explicitly:
     cd ${path} && gh pr view ${pr.number} --repo ${slug(pr.repo)} --json labels,statusCheckRollup
     cd ${path} && gh pr merge ${pr.number} --repo ${slug(pr.repo)} --squash --delete-branch

   BOTH LINES MATTER AND THE ORDER MATTERS. The permission that allows this merge is scoped to
   evidence a reader can see in the command text itself - which repository, and that the label
   and the checks were actually looked at on this pull request. A bare 'gh pr merge 412' shows
   none of that: not the repo, not the label, not the checks. Run without them, the merge is
   judged as an ordinary unreviewed merge and refused, which is what happened to thirteen
   attempts on 2026-08-24 before this instruction existed.

   Do not paraphrase the two commands, do not fold them into one, and do not drop --repo
   because 'cd' already put you in the right checkout - the point is that the command SAYS so.

   gh pr merge OFTEN PRINTS NOTHING ON SUCCESS. Silence looks like failure, and re-running it
   is how a lane reports a merge that did not happen, or attempts one twice. Verify:
     cd ${path} && gh pr view ${pr.number} --json state,mergeCommit
   state MERGED is the answer. 'merged' is not a field on this gh version - asking for it
   errors, which also reads as a failed merge.

   Then read the squash message back from git and check it the same way. GitHub adds trailers
   of its own.

7. CONFIRM YOU DID NOT BREAK MASTER. A green branch says nothing about the merge result - two
   changes can agree line by line and contradict in meaning, which is how master broke once
   already:
     cd ${path} && gh run list --branch master --limit 1 --json headSha,status,conclusion
   Wait for that run to finish. Report it in 'masterGreen'. If it went red, say so as the
   first thing in 'notes' and put the failing spec in 'failureDetail' - the deploy that would
   have followed is cancelled, and the next PR in the queue will stop on it.

8. DO NOT DEPLOY, and do not close the tracker issue. Both happen once, after every PR in this
   run has landed. Deploying between merges is what made a server change live in staging and
   not production, which as far as a tester is concerned is live in neither.

${LAW}

Return 'merged' only once state reads MERGED and you have looked at the master run that
followed.`
}

// Deploy is the one part of this file with no generic version, so it comes from the config
// rather than from here. A repo with no deploy command simply has nothing to deploy - which is
// true of a docs repo or a library - and saying so is better than inventing a step.
function deployCommands(landed) {
  const repos = [...new Set(landed.map((l) => l.repo))]
  const out = []
  for (const name of repos) {
    const cfg = CONFIGURED[name] || {}
    const cmds = cfg.deploy || []
    if (!cmds.length) continue
    out.push(`  # ${name}`)
    for (const c of cmds) out.push(`  cd ${REPOS[name]} && ${c}`)
  }
  return out.length
    ? out.join('\n')
    : `  (nothing landed in a repository that has a deploy command configured - say so in
  'notes' and return status 'not_needed' rather than inventing a deploy)`
}

function lastMerged(landed, name) {
  let found = null
  for (const l of landed) if (l.repo === name) found = l
  return found
}

const ONE_ENVIRONMENT = 'only'

function environments(name) {
  const deploy = ((CONFIGURED[name] || {}).deploy || [])
  return Array.isArray(deploy) ? deploy.filter(Boolean).length : 0
}

function readBacks(name) {
  const verify = (CONFIGURED[name] || {}).verify
  const targets = environments(name)
  const commands = typeof verify === 'string'
    ? (verify.trim() ? [{ environment: ONE_ENVIRONMENT, command: verify.trim() }] : [])
    : verify && typeof verify === 'object'
      ? Object.entries(verify)
        .filter(([, c]) => typeof c === 'string' && c.trim())
        .map(([environment, command]) => ({ environment, command: command.trim() }))
      : []
  if (!commands.length) {
    return { commands: [], why: `${name} records no verify command in .pitwall.json, so nothing here can read what its ${targets} environment(s) are serving` }
  }
  if (commands.length !== targets) {
    return { commands: [], why: `${name} deploys to ${targets} environment(s) and its verify names ${commands.length}, so ${targets > commands.length ? 'at least one environment' : 'an environment that is not deployed to'} can never be confirmed - set one command per environment in repos.${name}.verify, keyed by the environment name` }
  }
  return { commands, why: '' }
}

function liveReads(landed) {
  const reads = []
  const blocked = []
  for (const name of [...new Set(landed.map((l) => l.repo))]) {
    if (!DEPLOYS.has(name)) continue
    const { commands, why } = readBacks(name)
    if (why) blocked.push(why)
    for (const c of commands) reads.push({ repo: name, ...c })
  }
  return { reads, blocked }
}

function verifyCommands(landed) {
  const out = []
  for (const name of [...new Set(landed.map((l) => l.repo))]) {
    const verify = (CONFIGURED[name] || {}).verify
    if (typeof verify === 'string') {
      if (verify.trim()) out.push(`  ${verify.trim()}`)
    } else if (verify && typeof verify === 'object') {
      for (const c of Object.values(verify)) if (typeof c === 'string' && c.trim()) out.push(`  ${c.trim()}`)
    }
  }
  return out.length
    ? out.join('\n')
    : `  This project records no verify command in .pitwall.json. Work out what the deployed
  version is by whatever means the project offers, and say in 'notes' what you used - a deploy
  nobody confirmed is a deploy that may not have happened.`
}

function heldBackReads(landed) {
  const { reads, blocked } = liveReads(landed)
  const out = reads.map((r) => `  ${r.repo} ${r.environment}  ${r.command}`).concat(blocked.map((b) => `  ${b}`))
  return out.length ? out.join('\n') : '  (nothing that landed deploys anywhere a host could be read)'
}

function readSha(reported) {
  const s = String(reported == null ? '' : reported).trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(s) ? s : ''
}

function samePrefix(a, b) {
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a))
}

function deployPrompt(landed) {
  return `Deploy what just landed. THIS STEP MERGES NOTHING. Every commit below is ALREADY on
the default branch - the merges happened earlier in this same run - so nothing here asks you to
merge, to reopen, or to re-check a pull request. If something looks unmerged to you, say so in
'notes' and return 'partial'. Never merge anything to reconcile a mismatch.

Already merged, named by the commit each one became:
${landed.map((l) => `  ${l.repo} ${(l.mergeSha || '').slice(0, 12) || '(sha not recorded)'} - ${l.title}${l.issue ? ` (${l.issue})` : ''}`).join('\n')}

Named by merge sha rather than by pull request number ON PURPOSE, and it is not cosmetic. A PR
number carries the history of every run that ever touched it: the same number can be refused in
one run and merged in the next, which is the NORMAL course of events here because a PR that is
not pre-flighted waits for the following run. Naming those numbers in this prompt has twice
read as a contradiction of an earlier run's outcome and had the deploy refused - leaving master
ahead of production with nothing marking it, which is worse than the refusal it was protecting
against. A sha is on the branch or it is not, and 'git log' settles it without reference to any
other run.

EVERY ENVIRONMENT TOGETHER, in the order listed. A change live in one environment and not
another is live in neither as far as a tester is concerned - which is the whole reason this is
one step and not two.

${deployCommands(landed)}

DO NOT TOUCH THE MAIN CHECKOUT'S WORKING TREE. A person works in it, on their own branch, with
their own uncommitted edits, and it being on a feature branch is normal. Deploy tools generally
ship what the REMOTE default branch holds rather than what is checked out locally, so you do not
need it on master. Do not switch branches, do not pull, do not stash, and above all do not run
'git checkout --' on anything: that command has already destroyed a person's uncommitted
credentials work in one of these repositories.

Then READ BACK what each host is actually serving, rather than trusting that the deploy command
said Done:
${verifyCommands(landed)}

Every environment must report the sha you just merged. Report each in 'staging' and 'production'. If one deployed and
the other did not, that is status 'partial' and it is worth saying loudly - it is the exact
half-live state this step exists to prevent.
${landed.some((l) => l.repo === 'extension') ? `
The extension changed too. Rebuild it into the main checkout so it can be reloaded in Chrome:
dist/ is gitignored so building writes no tracked file, but the branch the checkout sits on
decides what gets built. If ${REPOS.extension} is on master and clean, pull and 'npm run
build'. If it is on any other branch or has uncommitted work, do NOT switch and do NOT stash -
build origin/master in a detached worktree and copy dist/ across. Do not package a release zip
and do not submit anything to the store.` : ''}
${landed.some((l) => l.repo === 'integration') ? `
The integration package changed. Rebuild and confirm dist/ is in step - CI fails if dist/ was
not rebuilt from src/. Do NOT publish to npm and do NOT push a tag: releasing is manual,
because the npm account has two-factor authentication and a one-time code cannot be given to
a workflow.` : ''}
${landed.some((l) => l.repo === 'docs') ? `
docs has no deploy target of its own. The change is on origin/master and visible to anyone who
pulls, but an ARTICLE is not live until publish.rb sends it, and a cover image is not live
until the SITE is deployed. Say which of those still apply.` : ''}

${LAW}`
}

function livePrompt(landed) {
  return `Report what revision each host below is serving. Nothing else is asked of you.

Deploy nothing, merge nothing, close nothing, re-run nothing, and change no code. This step only
reads, and what it reads is compared by the caller afterwards.

Run each of these and report what came back. Each line is one repository in one environment:
${liveReads(landed).reads.map((r) => `  ${r.repo}  ${r.environment}  ${r.command}`).join('\n')}

For each one, report the REVISION VALUE ON ITS OWN - the hex characters and nothing around them.
These endpoints answer with a document; the revision is one field of it, and the rest of the
document is not an answer to this question. Paste the hex, not the body it arrived in.

Report every line above as its own entry, carrying BOTH names printed beside it - the repository
and the environment - even the ones that did not answer. One repository appears once per
environment and the caller compares each environment separately, so an entry that names the wrong
environment is a report about a host nobody asked about. Report each line once: a second entry for
the same pair contradicts the first and is read as no answer at all.
An empty revision is the correct report for a host that did not answer, that timed out, or that
answered something with no revision in it. Return 'unreadable' as the status when that happened
to any of them, and 'read' when every command answered.

DO NOT WORK OUT WHETHER THIS IS THE RIGHT REVISION, and do not go looking for what it should be.
Whether what a host serves is current is not yours to judge and not yours to know - you have not
been told what merged, deliberately, because a step that knows the expected answer can produce
it without reading anything, and this step exists precisely because something else's word was
taken once already. Report what you read. Guess nothing, and fill nothing in.

DO NOT DEPLOY, whatever you find. A deploy is somebody's decision once they know what is live,
and this step is how they find out.
${LAW}`
}

// RETIRING A PULL REQUEST THE LANDER CANNOT LAND.
//
// Measured on the 2026-08-24 run: 113 minutes, 14 attempts, 4 merges. Four PRs came back
// 'conflict' (every one of them superseded by work already on master) and five came back
// 'red_after_rebase' (the five locale branches, red once French landed under them). Each
// attempt cost six to ten minutes and produced nothing.
//
// That would be tolerable once. The problem is that the label stayed on, so the NEXT run
// surveyed the same nine dead pull requests and spent the same seventy minutes rediscovering
// the same nine findings - and the run after that would too, forever. The `seen` set stops the
// repeat inside one run and does nothing across runs.
//
// So a stop is recorded where it survives: the label comes off, the finding goes onto the
// tracker issue, and the issue goes back to open so a lane can pick up the rework with the
// diagnosis already written down. Nothing is force-pushed and no branch is deleted - the
// author's work is left exactly as it was, only un-queued.
//
// NOT retired: 'master_red' (nothing is wrong with the PR), 'blocked' (CI simply had not
// finished - a timing accident that the next round should retry), 'version_unreadable' (the
// number could not be read at all, which is ignorance rather than a finding), and 'agent_error'
// (we do not know what happened, and un-queueing on ignorance loses work silently).
const RETIRE = { type: 'object', required: ['status'], additionalProperties: false, properties: {
  status: { enum: ['retired', 'partial', 'nothing_to_do'] },
  retired: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
} }

function retirePrompt(dead) {
  return `Take these pull requests out of the merge queue. They were attempted this run and
could not be landed, and the reason is recorded below. Leaving them labelled means every future
lander run attempts them again and rediscovers the same thing, at six to ten minutes each.

${dead.map((d) => `  ${d.slug}#${d.number} in ${REPOS[d.repo]} - ${d.why}${d.issue ? ` (tracker ${d.issue})` : ' (no tracker issue named)'}
    ${(d.detail || '').split('\n').join('\n    ').slice(0, 1200)}`).join('\n\n')}

FOR EACH ONE, three things, in this order:

1. Append the finding to its tracker issue, if it named one. Write the text to a file first and
   pass it with --append-notes, never --notes and never an inline double-quoted string:
     cd ${ROOT} && bd update <id> --append-notes "$(cat <file>)"
   --notes overwrites the whole field and has already destroyed a decision somebody recorded.
   Include: that the pull request was attempted and not landed, the reason above in full, that
   the label was removed, and that the branch was left untouched. Somebody reworking this needs
   the diagnosis more than they need the verdict.

2. Set the issue back to open, so the queue offers it again:
     cd ${ROOT} && bd update <id> --status open
   An issue left in_progress behind a dead pull request is invisible to the queue and stalls
   forever. That has stranded work here before.

3. Remove the label, LAST, so a crash between steps leaves the finding recorded rather than a
   pull request silently un-queued with no explanation anywhere:
     cd <that repo's checkout> && gh pr edit <number> --repo <owner/name> --remove-label ${LABEL}

DO NOT close the pull request, do not force-push, do not delete the branch, do not touch the
code. The work is fine; it just no longer applies to master as it stands. Reopening the
question later should start from the author's branch, not from nothing.

Read each tracker write back with bd show <id> --json - the rendered output truncates, and a
note that did not land is worse than one never attempted, because the label is gone either way.

Return status 'retired' with the ids you un-queued, 'partial' if some failed, naming which and
why, or 'nothing_to_do' if there were none.
${LAW}`
}

// Which repositories this workspace can actually deploy. Read from the config rather than
// assumed: a repository with no deploy command is one whose merge does not reach anybody, and
// its issue must not be closed as though it had.
const DEPLOYS = new Set(Object.entries(CONFIGURED || {})
  .filter(([, r]) => r && Array.isArray(r.deploy) && r.deploy.length)
  .map(([name]) => name))

function readHosts(landed, back) {
  const served = new Map()
  for (const h of (back && back.hosts) || []) {
    if (!h || typeof h.repo !== 'string' || typeof h.environment !== 'string') continue
    const key = `${h.repo}\u0000${h.environment}`
    const revision = readSha(h.revision)
    const seen = served.get(key)
    if (!seen) served.set(key, { revision })
    else if (seen.revision !== revision) served.set(key, { revision: '', contradicted: true })
  }
  const confirmed = []
  const mismatched = []
  const silent = []
  const states = []
  for (const name of [...new Set(landed.map((l) => l.repo))]) {
    if (!DEPLOYS.has(name)) continue
    const { commands, why } = readBacks(name)
    const expected = readSha((lastMerged(landed, name) || {}).mergeSha)
    if (why) { silent.push(why); states.push('unknown'); continue }
    if (!expected) { silent.push(`${name} recorded no merge sha, so what its hosts reported cannot be compared against anything`); states.push('unknown'); continue }
    let matched = 0
    let wrong = 0
    let unread = 0
    for (const c of commands) {
      const seen = served.get(`${name}\u0000${c.environment}`)
      if (seen && seen.contradicted) {
        unread += 1
        silent.push(`${name} ${c.environment} came back twice with two different revisions, and two contradictory answers are not an answer`)
      } else if (!seen || !seen.revision) {
        unread += 1
        silent.push(`${name} ${c.environment} reported no revision`)
      } else if (samePrefix(expected, seen.revision)) {
        matched += 1
        confirmed.push({ name, environment: c.environment, revision: seen.revision })
      } else {
        wrong += 1
        mismatched.push(`${name} ${c.environment} is serving ${seen.revision.slice(0, 12)}, and what merged was ${expected.slice(0, 12)}`)
      }
    }
    states.push(unread ? 'unknown' : wrong ? (matched ? 'partial' : 'failed') : 'deployed')
  }
  const status = (!back || back.status !== 'read' || !states.length || states.includes('unknown')) ? 'unknown'
    : states.every((st) => st === 'deployed') ? 'deployed'
      : states.every((st) => st === 'failed') ? 'failed'
        : 'partial'
  return { status, confirmed, mismatched, silent }
}

function closePrompt(landed, deployed) {
  return `Close the tracker issues for work that is now merged and deployed, and only those.

From ${ROOT} - the tracker is at the root, not inside any repository:
${landed.filter((l) => l.issue).map((l) => `  bd close ${l.issue} --reason "Landed in ${l.slug}#${l.number}${DEPLOYS.has(l.repo) ? ' and deployed' : ' - NOT deployed, see below'}"`).join('\n')}

THAT LIST IS THE WHOLE JOB. Do not survey the tracker for other issues, and do not read pull
requests this run did not land. On 2026-08-28 this step was handed ONE issue and went looking
anyway: it ran bd list, then gh pr view on ten PRs from earlier runs, and spent minutes
reconciling a backlog nobody had asked it to touch. The backlog was real - twelve issues sat in
progress because two earlier deploys had been refused - but finding it is not the same as being
asked to fix it, and an agent that closes issues outside its brief is closing them without the
evidence this prompt spends forty lines establishing.

IF YOU NOTICE OTHERS THAT LOOK LANDED AND STILL OPEN, SAY SO IN 'notes' AND CLOSE NOTHING. The
supervisor decides what happens to them. Naming them costs one line; closing them wrongly is
invisible, which is the failure this whole step is written around.

NOT EVERY REPOSITORY HAS A DEPLOY, and saying one deployed when it did not is a false claim
written into a closed issue where somebody will believe it later. Only these repositories have a
deploy command configured, and only their issues may be closed as deployed:
${[...DEPLOYS].join(', ') || '(none)'}

For anything else - an extension that ships through a store review, a package published by hand -
say MERGED and say what still has to happen for it to reach a user. A site deploy in the same run
is unrelated to it and must not be quoted as though it covered it. A safety check refused this
step on 2026-08-25 for exactly that: three issues were about to be closed as "landed and
deployed", two of them extension changes that a store release had not carried, on the strength of
a site deploy that happened in the same run.

READ EACH PR's BODY BEFORE CLOSING ITS ISSUE, and honour what it says about itself.

  cd <path> && gh pr view <number> --json body

Lanes state plainly when a change does NOT finish its ticket - the wording varies but the
meaning does not: "this PR does not finish the ticket", "that acceptance criterion stays open",
"the remaining half is a person's". WHERE A PR SAYS THAT, DO NOT CLOSE THE ISSUE. Append to it
instead, naming the merge and what is still outstanding:

  BEADS_DIR=${ROOT}/.beads bd update <id> --append-notes "Merged as <repo> #<n>, <sha>, and
  deployed. NOT closed: the PR states <what remains>."

MERGED AND DONE ARE DIFFERENT FACTS AND YOU ONLY KNOW ONE OF THEM. On 2026-08-26 this step
closed app-w23d.11 when PR #509 merged. Its acceptance criteria required scoring the real
template on mail-tester from the real mailbox - a person's job that had not happened - and the
implementing lane had written, in its own handoff, "This PR does not finish the ticket ... which
is why the issue must stay open when the lander merges the change". Nobody read it. A supervisor
noticed and reopened it by hand; had they not, the outreach epic would have carried a closed
ticket whose remaining half was the one thing standing between a campaign and a domain that had
already landed in spam once.

Closing early is the worse error of the two available here. An issue left open gets looked at
again; an issue closed wrongly is invisible.

Write a reason that says what landed and where, so somebody reading the closed issue in a
month knows what happened without opening a PR.

Deploy result: ${deployed}

IF THE DEPLOY DID NOT SUCCEED, CLOSE NOTHING. A merge that is not live is not done, and an
issue closed early is one nobody looks at again. Say so and return instead.
${landed.filter((l) => !l.issue).length ? `
These landed but named no tracker issue, so there is nothing to close for them - report them
so a person can decide whether one was missed:
${landed.filter((l) => !l.issue).map((l) => `  ${l.slug}#${l.number} - ${l.title}`).join('\n')}` : ''}

Use --reason, never --notes: --notes overwrites the whole field and has already destroyed a
decision somebody recorded. Change no code.

REPORT THE IDS YOU ACTUALLY CLOSED, one per bd close that succeeded, and an empty list if none
were. Anything in the list above that you do not name comes back as drift a person has to chase:
on 2026-09-09 this step was killed mid-run and four merged-and-deployed issues sat in_progress
for hours with nothing anywhere reporting it. An id you closed and did not name reads the same
way, so name them - and do not name one you did not close.
${LAW}`
}

phase('Survey')

// Taken before anything is surveyed and given back in the finally below, whatever happened.
// A person merges by hand in these repositories - twice in one session, most recently while a
// supervisor was mid-investigation - so being the only lander is not the same as being the
// only thing merging.
const lock = await agent(lockPrompt(), { label: 'lock', phase: 'Survey', schema: LOCK, model: 'haiku', effort: 'low' })
const token = trimmed(lock && lock.token)
const holder = trimmed(lock && lock.holder)
if (!lock || lock.status !== 'taken') {
  log(`merge lock held by ${holder || 'somebody'} - not landing anything this run`)
  return { landed: [], stopped: [], skipped: [], deployed: 'not_needed', lockedOutBy: lock ? holder : null }
}

const mintedHere = !!token && TOKEN_SHAPE.test(token) && holder === token
if (!mintedHere) {
  const unproven = `LEAKED - the lock step reported taken, but ${MERGE_LOCK}/holder reads [${holder}] against a token of [${token}], so this run cannot prove the lock is its own. Nothing was landed and nothing was removed. Read ${MERGE_LOCK}/holder: if it names a run that has finished, clear it; if it names another lander, it is theirs and they give it back themselves.`
  log(unproven)
  return { landed: [], stopped: [], skipped: [], deployed: 'not_needed', lock: unproven, lockedOutBy: holder }
}

const landed = []
const stopped = []
// Not dead, just not ready: a PR the pre-merge check found unlabelled, red or with an empty
// rollup. Reported so a run that lands nothing says WHY rather than looking idle.
const skipped = []
// Which pre-flighted keys the survey actually turned up. Only used to complain at the end
// about ones that never matched anything: a number handed in against a repository that never
// listed it filters that PR out silently and the run looks like a clean drain of a queue it
// never touched. A typo has to be loud or it is worse than no filter at all.
const matchedPreflight = new Set()
const surveyedEver = new Map()
let masterBroken = false
let deployed = 'not_needed'
let closed = null
let unclosed = []
let lockState = `LEAKED - the release step never reported. Read ${MERGE_LOCK}/holder before touching anything.`

try {
  // Drained rather than surveyed once: a lane can label a PR while this run is working, and
  // "deploy when lane-verified is empty" is only true if we look again before believing it.
  // Capped because a queue that refills forever should hand back rather than never return.
  const seen = new Set()
  for (let round = 1; round <= MAX_ROUNDS && !masterBroken; round++) {
    const survey = await agent(surveyPrompt(), { label: `survey${round > 1 ? `#${round}` : ''}`, phase: 'Survey', schema: SURVEY, model: 'sonnet' })
    // Priority first, then oldest first within a priority - the survey already returns oldest
    // first, and a stable sort keeps that order inside each band. A PR whose issue nobody could
    // read sorts last rather than first: an unknown priority is not an emergency, and putting it
    // ahead of a known P0 would be the very bug this ordering exists to fix.
    //
    // Why this matters more than tidiness: on 2026-08-26 a P0 that unblocked a red master sat
    // behind two P3s. They merged, master went red, and the lander then correctly refused to
    // merge into a red master - so it could not land the fix for the red master. Queue order
    // alone turned two correct rules into a deadlock a person had to break.
    const surveyed = ((survey && survey.prs) || [])
      .map(resolveRepo)
      .filter((p) => !seen.has(keyOf(p)))
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const pa = typeof a.p.priority === 'number' ? a.p.priority : 99
        const pb = typeof b.p.priority === 'number' ? b.p.priority : 99
        return pa - pb || a.i - b.i
      })
      .map(({ p }) => p)

    for (const p of surveyed) surveyedEver.set(keyOf(p), p)

    const foreign = surveyed.filter((p) => !p.repo)
    for (const p of foreign) {
      seen.add(keyOf(p))
      skipped.push({ ...p, why: `no configured repository has the slug ${p.slug || '(the survey reported none)'} - nothing was merged and the label was left on` })
      log(`SKIPPED ${keyOf(p)} - no configured repository has that slug`)
    }
    const known = surveyed.filter((p) => p.repo)

    // Keep only what the supervisor actually looked at. See PREFLIGHTED near the top for why
    // this run cannot merge anything else. This is NOT a rejection: the PR keeps its label,
    // stays open, and lands on the next run, whose pre-flight will have seen it.
    //
    // Marked seen as well as skipped, so the re-survey rounds below do not rediscover and
    // re-report the same PR every round until MAX_ROUNDS runs out. Deliberately NOT
    // seen.delete()d the way a failed pre-merge check is - that one can resolve inside this
    // run, and this one cannot.
    const queue = PREFLIGHTED
      ? known.filter((p) => PREFLIGHTED.has(keyOf(p)))
      : known

    if (PREFLIGHTED) {
      for (const p of known) {
        if (PREFLIGHTED.has(keyOf(p))) { matchedPreflight.add(keyOf(p)); continue }
        seen.add(keyOf(p))
        skipped.push({ ...p, why: 'not pre-flighted - labelled after the supervisor surveyed the queue' })
        log(`SKIPPED ${keyOf(p)} - not pre-flighted, lands next run`)
      }
    }

    if (!queue.length) {
      // Distinguished on purpose: "nothing was ready" and "things were ready but none of them
      // were ours to merge" want different reactions from whoever reads the log, and the
      // second one is a signal to launch another run rather than to stand down.
      const why = round > 1
        ? 'queue drained'
        : surveyed.length
          ? `nothing pre-flighted to land - ${known.length} labelled but none seen by the supervisor, relaunch to pick them up`
          : 'nothing labelled lane-verified - nothing to land'
      log(why)
      break
    }

    log(`round ${round}: ${queue.length} to land - ${queue.map(keyOf).join(' ')}`)

    // Serial by construction. This loop is the whole design: one rebase, one CI wait, one
    // merge, then the next. Nothing here should ever be wrapped in parallel().
    for (let i = 0; i < queue.length; i++) {
      const pr = queue[i]
      seen.add(keyOf(pr))
      phase('Land')

      // THERE USED TO BE A SEPARATE 'verify' AGENT HERE, and it is gone deliberately.
      //
      // It existed to ask, before spending a merge agent, whether the PR was still labelled and
      // still green - because an agent already handed a merge is a worse place to discover the
      // merge should not happen. Both failure modes it caught are real: a label pulled back
      // mid-run, and a rebased head that was red while the label still said otherwise.
      //
      // land-one.sh now makes BOTH of those checks itself, in shell, as the land agent's first
      // action, and exits 7 without merging anything. So the protection is intact while the
      // agent that used to provide it is not. That agent cost about 50k of transcript every
      // time it ran - PER PULL REQUEST - for two tool calls, because an agent pays for its
      // context whatever it does. Fourteen PRs paid that fourteen times.
      //
      // A PR that comes back 7 is NOT retired: status 'blocked' puts it back for a later round,
      // which is what the old skipped-and-seen.delete path did.
      const declared = await agent(versionPrompt(pr), {
        label: `version:${keyOf(pr)}`, phase: 'Land', schema: VERSION, model: 'haiku', effort: 'low'
      })
      const stale = versionVerdict(declared)
      if (stale && stale.defer) {
        seen.delete(keyOf(pr))
        log(`DEFERRED ${keyOf(pr)} - ${stale.detail}, and the version step reports ${stale.defer}, so nothing is un-queued and no merge is delegated; it goes back for a later round`)
        continue
      }
      if (stale) {
        stopped.push({ ...pr, why: stale.why, detail: stale.detail })
        log(`STOPPED ${keyOf(pr)} - ${stale.why}\n    ${stale.detail}`)
        continue
      }
      if (declared && (declared.labelled === false || declared.open === false)) {
        log(`${keyOf(pr)} - the version step reports it is no longer the pull request this run was asked to merge (${LABEL} ${declared.labelled === false ? 'is gone' : 'still on'}, ${declared.open === false ? 'closed, merged or draft' : 'open'}), and its declared version raises no objection, so land-one.sh decides in shell whether it still merges`)
      }
      if (declared && declared.status === 'read' && !declared.touchesPlugin) {
        log(`${keyOf(pr)} - declares devloop plugin version ${trimmed(declared.branchVersion) || '(none)'} against origin/master's ${trimmed(declared.masterVersion) || '(none)'}, and its diff lists no path under plugins/ or .claude-plugin/, so the versions are not compared`)
      }
      if (declared.status === 'no_manifest') {
        log(`${keyOf(pr)} - origin/master carries no ${PLUGIN_MANIFEST}, so this repository has no published plugin version to walk backwards`)
      }

      const r = await agent(landPrompt(pr, i + 1, queue.length), {
        label: `land:${keyOf(pr)}`, phase: 'Land', schema: LAND
      })

      if (r && r.status === 'merged') {
        landed.push({ ...pr, mergeSha: r.mergeSha })
        log(`LANDED ${keyOf(pr)} - ${pr.title}`)

        if (r.masterGreen === false) {
          masterBroken = true
          log(`MASTER RED after ${keyOf(pr)} - stopping, nothing else lands and nothing deploys\n    ${r.failureDetail || r.notes}`)
          break
        }

        // The owner asked for a deploy every ten merges as well as at the end, so a long run
        // is not one enormous undeployed batch.
        if (landed.length % DEPLOY_EVERY === 0) {
          phase('Deploy')
          const mid = await agent(deployPrompt(landed.slice(-DEPLOY_EVERY)), { label: `deploy:${landed.length}`, phase: 'Deploy', schema: DEPLOYED })
          log(`deployed at ${landed.length} merges: ${(mid && mid.status) || 'unknown - that step reported nothing, and the deploy at the end of this run covers the same merges'}`)
        }
        continue
      }

      const why = r ? r.status : 'agent_error'

      // 'blocked' means CI had not finished in the time the attempt had, not that anything is
      // wrong with the pull request. Keeping it in `seen` retires it from this whole run over a
      // stopwatch, and the rebase it already did is thrown away. Put it back so a later round
      // finds the run finished - by then it usually has.
      if (why === 'blocked') {
        seen.delete(keyOf(pr))
        log(`DEFERRED ${keyOf(pr)} - CI had not finished; it goes back for a later round`)
        continue
      }

      stopped.push({ ...pr, why, detail: r && (r.failureDetail || r.notes) })
      log(`STOPPED ${keyOf(pr)} - ${why}\n    ${(r && (r.failureDetail || r.notes)) || 'the agent returned nothing'}`)

      // A red master blocks everything behind it, so there is no point trying the rest.
      //
      // BUT SAY WHETHER THE CURE IS IN THIS QUEUE. The failing spec is named in failureDetail;
      // if a PR still waiting names the same file, that PR is very likely the fix for the break
      // that is stopping it - the deadlock of 2026-08-26 in one line. This does not merge it:
      // the master-green rule is right and stays. It hands the supervisor the one fact they
      // would otherwise have to re-derive from a red run and a queue.
      if (why === 'master_red') {
        masterBroken = true
        const detail = (r && (r.failureDetail || r.notes)) || ''
        const specs = (detail.match(/[\w./-]+_spec\.rb/g) || []).map((f) => f.split('/').pop())
        const suspects = specs.length
          ? queue.slice(i + 1).filter((q) => specs.some((f) => (q.title || '').includes(f.replace('_spec.rb', ''))))
          : []
        if (suspects.length) {
          log(`ONE OF THE PRs STILL QUEUED MAY BE THE FIX FOR THIS RED MASTER: ${suspects.map(keyOf).join(' ')}\n    the failing spec is ${specs.join(', ')} and those titles mention it. Not merged - master must go green first - but check before treating the queue as blocked.`)
        } else if (specs.length) {
          log(`Failing spec: ${specs.join(', ')}. No PR still queued mentions it, so the fix is not in this run.`)
        }
        break
      }
    }
  }

  const acted = new Set([...landed, ...stopped, ...skipped].map(keyOf))
  for (const [key, pr] of surveyedEver) {
    if (acted.has(key)) continue
    const why = masterBroken
      ? 'not attempted - master was red in front of it, so nothing behind it was tried'
      : `surveyed but not landed after ${MAX_ROUNDS} rounds - CI had not finished in the time this run had; still labelled, lands next run`
    skipped.push({ ...pr, why })
    log(`NOT ACTED ON ${key} - ${why}`)
  }

  // Before anything else, un-queue what could not be landed - including when nothing landed at
  // all, which is exactly the run whose findings would otherwise be repeated in full.
  const dead = stopped.filter((sp) => sp.why === 'conflict' || sp.why === 'red_after_rebase' || sp.why === 'version_not_ahead')
  if (dead.length) {
    phase('Deploy')
    const rt = await agent(retirePrompt(dead), { label: `retire:${dead.length}`, phase: 'Deploy', schema: RETIRE, model: 'sonnet' })
    log(`retired ${dead.length} unlandable PR(s): ${(rt && rt.status) || 'agent_error'}`)
  }

  if (landed.length && !masterBroken) {
    phase('Deploy')
    const d = await agent(deployPrompt(landed), { label: 'deploy', phase: 'Deploy', schema: DEPLOYED })
    deployed = (d && d.status) || 'unknown'
    let servingText = d && readSha(d.staging) ? `staging ${readSha(d.staging).slice(0, 8)} production ${readSha(d.production).slice(0, 8) || '(not a revision)'}` : ''

    if (deployed === 'unknown' && !landed.some((l) => DEPLOYS.has(l.repo))) {
      deployed = 'not_needed'
      log('the deploy step reported nothing, and nothing that landed is in a repository with a deploy configured - there was never anything to deploy, and that is settled by the config rather than by the step')
    } else if (deployed === 'unknown') {
      const { reads, blocked } = liveReads(landed)
      if (blocked.length || !reads.length) {
        log(`the deploy step reported nothing, and reading the hosts back cannot settle it either, so the deploy stays unknown and the issues stay open until a person reads a host:\n    ${(blocked.length ? blocked : ['nothing that landed deploys anywhere a host could be read']).join('\n    ')}`)
      } else {
        const back = await agent(livePrompt(landed), { label: 'deploy-check', phase: 'Deploy', schema: LIVE, model: 'haiku', effort: 'low' })
        const read = readHosts(landed, back)
        deployed = read.status
        if (read.confirmed.length) servingText = read.confirmed.map((c) => `${c.name} ${c.environment} ${c.revision.slice(0, 8)}`).join(' ')
        log(`the deploy step reported nothing, so the hosts were read back instead - deploy is ${deployed}${back && back.notes ? `\n    ${back.notes}` : ''}`)
        for (const line of [...read.mismatched, ...read.silent]) log(`    ${line}`)
      }
    }
    log(`deploy: ${deployed}${servingText ? ` ${servingText}` : ''}`)

    // "A merge that is not live is not done" is the right rule for a repository that HAS a
    // deploy. For one that does not, there is nothing to wait for and the gate never opens.
    //
    // It bit on 2026-08-25: a run landed only docs#33, deployed came back 'not_needed', and this
    // branch read that as failure and closed nothing - leaving a finished issue in_progress and
    // invisible to the queue as "awaiting lander" forever. Twelve issues had already piled up
    // that way earlier the same day and were closed by hand.
    //
    // So the question is per issue, not per run: close what is live, plus everything whose
    // repository has no deploy to be live in.
    const closable = landed.filter((l) => !DEPLOYS.has(l.repo) || deployed === 'deployed')
    const heldBack = landed.filter((l) => !closable.includes(l))

    if (closable.length) {
      phase('Deploy')
      const where = deployed === 'deployed'
        ? `deployed${servingText ? ` - ${servingText}` : ''}`
        : 'these repositories have no deploy to be live in, so they are closed on the merge alone'
      const c = await agent(closePrompt(closable, where), { label: 'close', phase: 'Deploy', model: 'sonnet', effort: 'low', schema: CLOSED })
      closed = (c && c.status) || 'unknown'
      const reported = new Set((c && c.closed) || [])
      unclosed = closable.filter((l) => l.issue && !reported.has(l.issue)).map((l) => l.issue)
      if (unclosed.length) {
        log(`CLOSE ${closed === 'unknown' ? 'UNKNOWN - that step reported nothing, which is not the same as a refusal' : closed} - these merged and deployed and nothing confirmed they were closed, so they are sitting in_progress with nothing reporting it: ${unclosed.join(' ')}\n    Check them with bd show before closing anything by hand.${c && c.notes ? `\n    ${c.notes}` : ''}`)
      } else if (reported.size) {
        log(`closed ${reported.size} issue(s) - ${[...reported].join(' ')}`)
      } else {
        log(`nothing to close - what landed in this run named no tracker issue, so there is nothing sitting in_progress behind it${closed === 'unknown' ? ', and the close step reported nothing either' : ''}`)
      }
    }
    if (heldBack.length) {
      const waiting = heldBack.map((l) => l.issue || keyOf(l)).join(' ')
      if (deployed === 'unknown') {
        log(`deploy UNKNOWN - nothing reported whether it happened and reading the hosts back did not settle it either. THIS IS NOT A FAILURE and must not be re-run on the strength of this line. What settles it, in this order: what each host is serving, against the shas that merged.\n${heldBackReads(landed)}\n    merged: ${landed.map((l) => `${l.repo} ${(l.mergeSha || '').slice(0, 12) || '(sha not recorded)'}`).join(', ')}\n    left open until somebody says: ${waiting}`)
      } else {
        log(`deploy ${deployed} - staying open until it is live: ${waiting}`)
      }
    }
  } else if (masterBroken) {
    log('master is red - nothing deployed and nothing closed')
  }
} finally {
  // However this ended. A run that merged and then died before releasing held every other
  // lane up for twenty minutes with nothing behind it.
  if (!token || !TOKEN_SHAPE.test(token)) {
    lockState = `LEAKED - ${MERGE_LOCK} is held under a token this run cannot quote back, so no removal was even asked for. Read ${MERGE_LOCK}/holder, and leave it alone unless it names a run that has finished.`
    log(lockState)
  } else {
    const released = await agent(releasePrompt(token), { label: 'release', phase: 'Deploy', model: 'haiku', effort: 'low', schema: RELEASE })
    if (released && released.status === 'released') {
      lockState = 'released'
    } else if (released && released.status === 'not_mine') {
      lockState = `not_mine - ${MERGE_LOCK}/holder did not hold ${token}, so nothing was removed and nothing should be`
      log(`${lockState}.\n    ${released.notes || 'the script reported NOT_MINE and says what the holder file read instead'}`)
    } else if (released && released.status === 'already_gone') {
      lockState = `already_gone - ${MERGE_LOCK} was not there to release`
      log(`${lockState}. Something removed this run's lock while it was working, so another lander may have been running beside it.\n    ${released.notes || ''}`)
    } else {
      lockState = `LEAKED - ${MERGE_LOCK} still held ${token} after the release step, or the step answered nothing. Check ${MERGE_LOCK}/holder still reads ${token} before removing it - if it reads anything else, another lander has it and it is not yours.`
      log(`${lockState}\n    ${(released && released.notes) || 'the release agent returned nothing'}`)
    }
  }
}

if (PREFLIGHTED) {
  // Never matched a surveyed PR in any round. Either the PR closed or lost its label between
  // the supervisor's query and this run - harmless - or it was handed in against a repository
  // that never listed that number, which silently excluded real work. Both want a person's eye,
  // and the second one is invisible without this line.
  const unmatched = [...PREFLIGHTED].filter((k) => !matchedPreflight.has(k))
  if (unmatched.length) {
    log(`pre-flighted but never surveyed: ${unmatched.join(' ')} - closed, unlabelled, or a number paired with a repository that never listed it`)
  }
}

log(`landed ${landed.length}, stopped ${stopped.length}, skipped ${skipped.length}, deploy ${deployed}${unclosed.length ? `, NOT CONFIRMED CLOSED ${unclosed.join(' ')}` : ''}`)
return { landed, stopped, skipped, deployed, closed, unclosed, masterBroken, lock: lockState }
