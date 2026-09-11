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
const TOKEN_SHAPE = /^[A-Za-z0-9._-]+$/
const PLUGIN_MANIFEST = 'plugins/devloop/.claude-plugin/plugin.json'
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const trimmed = (v) => String(v || '').trim()

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

const VERSION = {
  type: 'object',
  required: ['status', 'masterVersion', 'branchVersion', 'touchesPlugin', 'notes'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['read', 'no_manifest', 'unreadable'], description: "'read' only when both git show calls printed a manifest you could copy a version string out of" },
    masterVersion: { type: 'string', description: `the "version" string in origin/master's ${PLUGIN_MANIFEST}, verbatim. An empty string when you could not read one.` },
    branchVersion: { type: 'string', description: `the "version" string in the train branch's ${PLUGIN_MANIFEST}, verbatim. An empty string when you could not read one.` },
    touchesPlugin: { type: 'boolean', description: 'true when the train changes any file under plugins/ or .claude-plugin/ - that is what the marketplace serves' },
    notes: { type: 'string' },
  },
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
      detail: `origin/master's ${PLUGIN_MANIFEST} could not be read - ${trimmed(read.notes) || `the step reported only '${read.status}'`}`,
    }
  }
  if (!read.touchesPlugin) return null
  const branch = trimmed(read.branchVersion)
  const master = trimmed(read.masterVersion)
  const ahead = versionAhead(branch, master)
  if (ahead === null) {
    return {
      why: 'version_unreadable',
      detail: `the declared devloop plugin version cannot be compared - the train reported '${branch}' and origin/master reported '${master}', and a version that is not three numbers cannot be ordered against anything`,
    }
  }
  if (!ahead) {
    return {
      why: 'version_not_ahead',
      detail: `the train declares devloop plugin version ${branch} and origin/master holds ${master}, which is not strictly greater. One of the branches on it has to bump ${PLUGIN_MANIFEST} and ${MARKETPLACE_MANIFEST} above ${master}.`,
    }
  }
  return null
}

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

function versionPrompt(trainBranch) {
  return `Read two version numbers and report them. Nothing merges here, nothing is edited, and
the working tree of ${REPO_PATH} is not yours to move - a person works in that checkout.

FETCH FIRST. What matters is the number origin/master holds RIGHT NOW, at the moment this train
is about to merge, not the one it held when the train was built or when its checks started.

${SHELL_FIRST}

  cd ${REPO_PATH} && git fetch origin --quiet && echo FETCHED
  cd ${REPO_PATH} && git ls-tree --name-only origin/master ${PLUGIN_MANIFEST}
  cd ${REPO_PATH} && git show origin/master:${PLUGIN_MANIFEST}
  cd ${REPO_PATH} && git show origin/${trainBranch}:${PLUGIN_MANIFEST}
  cd ${REPO_PATH} && git diff --name-only origin/master...origin/${trainBranch}

git show prints a file as it is at a ref and touches nothing. Do not check anything out, do not
switch, do not reset, and do not stash.

REPORT, DO NOT JUDGE. Whether this train may merge is decided from what you report, not by you:

  status 'read'         FETCHED printed, ls-tree printed the path, and both git show calls printed
                        a manifest. Copy the "version" string out of each into masterVersion and
                        branchVersion, verbatim - do not normalise them, pad them, or correct one
                        to look like the other.
  status 'no_manifest'  ls-tree printed NOTHING. ${PLUGIN_MANIFEST} is not in master's tree, so
                        this repository ships no plugin and has no published number to walk
                        backwards. Skip the two git show calls - there is nothing there to read,
                        and their error is the expected result rather than a problem.
  status 'unreadable'   FETCHED did not print, or ls-tree printed the path and a git show then
                        failed anyway, or the manifest it printed carries no "version" string.
                        Say which in notes.

AN UNREADABLE MASTER IS NOT A CLEAR ROAD. If the fetch did not work, or the manifest is in the
tree and you still cannot get a number out of it, report 'unreadable' and say why. Guessing a
number turns a guard into a green light, and the merge that follows is the thing the guard exists
to stop.

WHAT ls-tree PRINTS IS WHAT DECIDES BETWEEN THE OTHER TWO, and nothing else decides it. Empty
output means 'no_manifest'. Do not reach for 'no_manifest' because some other command errored, and
do not report 'unreadable' for a repository that simply has no plugin in it - most of them do not,
and the whole train is refused either way on a verdict that was never about the version.

touchesPlugin is true when that last command lists ANY path under plugins/ or .claude-plugin/.
Those are the files the marketplace serves, so a train changing one of them ships under whatever
number it declares. It is false when the diff lists none of them.

Never use 2>&1 - it makes some commands fail outright. Use absolute paths, never relative ones.`
}

function retirePrompt(built, included, what, comment) {
  return `The release train ${built.trainBranch}, pull request #${built.trainPr} on ${SLUG},
${what}. Retire it so it does not sit on the remote looking like open work:

${SHELL_FIRST}

  cd ${REPO_PATH}
  gh pr close ${built.trainPr} --repo ${SLUG} --delete-branch --comment "<one line: ${comment}>"
  git fetch origin --prune --quiet
  git branch -r --list 'origin/${built.trainBranch}'

The last command must print NOTHING. If the branch is still listed, say so - a leftover train
branch is clutter that outlives the run and nobody else removes it.

DO NOT touch the pull requests it carried (${included.join(', ')}). They keep their labels and
go back in the queue; closing them would throw away work that is probably fine. Only the train
branch and the train's own pull request are yours to remove.`
}

function buildPrompt(only, suffix) {
  const onlyArg = only ? ` --only "${only.join(' ')}"` : ''
  const suffixArg = suffix ? ` --suffix ${suffix}` : ''
  return `Build a release train and report what went on it. ONE command does the work:

${SHELL_FIRST}

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

${SHELL_FIRST}

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

${SHELL_FIRST}

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

${SHELL_FIRST}

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

If it prints HELD, another lander is running. Read who has it, and DO NOTHING ELSE - do not
remove the lock, do not wait for it, do not proceed:

  cat /tmp/devloop-merge.lock/holder

Report status "held" and what cat printed as 'holder'. If the file is not there yet, report an
empty 'holder' - that is how a lock looks between another run's mkdir and its printf, and this
field is the one ownership is decided from, so a value filled in to have something to say is
worse than none.

If it prints TAKEN, STAMP THE LOCK WITH AN IDENTITY THAT IS YOURS. The holder file used to say
just "lander", which identifies nothing, so the release step could not prove the lock it was
about to delete was its own - it removed a shared resource unconditionally, which is rightly
refused, and every train leaked its lock and needed clearing by hand. Mint a token instead:

  TOKEN="land-train-$(date +%s)-$$"
  printf '%s\\n' "$TOKEN" > /tmp/devloop-merge.lock/holder
  cat /tmp/devloop-merge.lock/holder

Report status "taken", the token you wrote as 'token', and what cat printed back as 'holder',
verbatim and untidied. Report both even when they are identical, and do not correct either one to
match the other: the train compares them and stands down when they differ, because the file is
the fact and the value you report is a claim about it. The newline the file ends with and cat
prints back is not a difference - the train ignores whitespace around both values. The release
step is handed what you report and can compare against nothing else, so a token you omit or
retype is a lock this run cannot give back.`,
  { schema: { type: 'object', required: ['status', 'holder'], properties: {
      status: { type: 'string', enum: ['taken', 'held'] }, token: { type: 'string' },
      holder: { type: 'string' } } },
    model: 'haiku', effort: 'low', phase: 'Lock' },
)

const token = trimmed(lock && lock.token)
const holder = trimmed(lock && lock.holder)
if (!lock || lock.status !== 'taken') {
  return { status: 'held', notes: `Another lander holds /tmp/devloop-merge.lock${holder ? `, whose holder file reads [${holder}]` : ''}. Nothing was done.` }
}

if (!token || !TOKEN_SHAPE.test(token) || holder !== token) {
  const unproven = `LEAKED - the lock step reported taken, but /tmp/devloop-merge.lock/holder reads [${holder}] against a token of [${token}], so this train cannot prove the lock is its own. Nothing was built and nothing was removed. Read /tmp/devloop-merge.lock/holder: if it names a run that has finished, clear it; if it names another lander, it is theirs and they give it back themselves.`
  return { status: 'held', notes: unproven, lock: unproven }
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
let outcome = { stopped: null }
let stranded = []
let released = null
let lockState = `LEAKED - the release step never reported. Read /tmp/devloop-merge.lock/holder before touching anything.`

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
    const declared = await agent(versionPrompt(built.trainBranch), {
      schema: VERSION, phase: 'Merge', label: `version:#${built.trainPr}`, model: 'haiku', effort: 'low',
    })
    const stale = versionVerdict(declared)
    if (stale) {
      log(`REFUSED #${built.trainPr} - ${stale.why}\n    ${stale.detail}`)
      await agent(
        retirePrompt(built, included, 'cannot merge and is being abandoned',
          'the devloop plugin version it declares is not ahead of master, the changes it carried are going back to the queue'),
        { model: 'haiku', effort: 'low', phase: 'Merge', label: `retire:#${built.trainPr}` },
      )
      return { stopped: stale.why, notes: stale.detail }
    }
    if (declared && declared.status === 'read' && !declared.touchesPlugin) {
      log(`#${built.trainPr} declares devloop plugin version ${trimmed(declared.branchVersion) || '(none)'} against origin/master's ${trimmed(declared.masterVersion) || '(none)'}, and its diff lists no path under plugins/ or .claude-plugin/, so the versions are not compared`)
    }

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
    retirePrompt(built, included, 'failed its checks and is being abandoned',
      'failed CI, the changes it carried are going back to the queue and will be tried again separately'),
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

try {
outcome = await runTrain(ONLY, '', 0)

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
stranded = [...skipped].filter((n) => !landed.includes(n))
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
} finally {
if (!token || !TOKEN_SHAPE.test(token)) {
  lockState = `LEAKED - /tmp/devloop-merge.lock is held under a token this run cannot quote back, so no removal was even asked for. Read /tmp/devloop-merge.lock/holder, and leave it alone unless it names a run that has finished.`
  log(lockState)
} else {
released = await agent(
  `Release the serial merge lock. This runs however the train ended - merged, stopped or failed -
because a lock left behind stands down every train after it for no reason.

RUN THIS ONE COMMAND, EXACTLY AS IT STANDS, AND NOTHING ELSE:

  bash ${SKILL_DIR}/release-lock.sh --lock /tmp/devloop-merge.lock --token '${token}'

It reads the holder file, removes the lock only if that file holds this run's token, and prints
what it did on its first line: RELEASED, NOT_MINE, ALREADY_GONE or STILL_HELD. Report that word
lowercased as 'status' and every other line it printed as 'notes'. You are reporting its answer,
not forming one.

THE TOKEN IS ALREADY IN THAT COMMAND. Do not ask anybody for one and do not stop for want of one.
A sibling lander's release step was once told to "substitute the token the lock step reported",
read that as an instruction to go and find one, concluded it had been given nothing, and returned
that refusal as its answer while the run reported success. The lock outlived it by 25 minutes.

DO NOT LOOK AFTERWARDS TO SEE WHETHER THE LOCK IS GONE, and do not take the command apart into a
cat, an rm and an ls. You cannot verify a release by re-reading the lock afterwards - between the
removal and the check, another lander taking the lock is the system working, not a fault, and a
second look cannot tell that apart from a removal that failed. That is why the removal and the
report happen inside one process here, and why its output is the whole result.

NOT_MINE IS A CORRECT OUTCOME. The holder file does not hold this run's token, so nothing was
removed and nothing should be - a lock that belongs to another train is not this one's to clear.
ALREADY_GONE likewise: there was nothing to release. Report what it printed and stop.`,
  { schema: { type: 'object', required: ['status'], properties: {
      status: { enum: ['released', 'not_mine', 'already_gone', 'still_held'], description: 'the first word release-lock.sh printed, lowercased' },
      notes: { type: 'string', description: 'every other line it printed' } } },
    model: 'haiku', effort: 'low', phase: 'Close', label: 'release' },
)
if (released && released.status === 'released') {
  lockState = 'released'
} else if (released && released.status === 'not_mine') {
  lockState = `not_mine - /tmp/devloop-merge.lock/holder did not hold ${token}, so nothing was removed and nothing should be`
  log(`${lockState}.\n    ${released.notes || 'the script reported NOT_MINE and says what the holder file read instead'}`)
} else if (released && released.status === 'already_gone') {
  lockState = 'already_gone - /tmp/devloop-merge.lock was not there to release'
  log(`${lockState}. Something removed this run's lock while it was working, so another train may have been running beside it.\n    ${released.notes || ''}`)
} else {
  lockState = `LEAKED - /tmp/devloop-merge.lock still held ${token} after the release step, or the step answered nothing. Check /tmp/devloop-merge.lock/holder still reads ${token} before removing it - if it reads anything else, another train has it and it is not yours.`
  log(`${lockState}\n    ${(released && released.notes) || 'the release agent returned nothing'}`)
}
}
}

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
  lock: lockState,
}
