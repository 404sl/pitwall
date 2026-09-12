export const meta = {
  name: 'land-train',
  description: 'Land one repository\'s ready pull requests as one release train: build it, test it once, merge, deploy, close',
  whenToUse: 'When lane-verified pull requests are queued and the merge lock is free. A train covers ONE repository per run and args.repo is REQUIRED - it names which, it is refused rather than guessed, and the result reports every other configured repository with the relaunch to run for it. If this run ends with stopped=merge_refused, the supervisor must run `gh pr view <trainPr> --repo <slug> --json labels,statusCheckRollup` in ITS OWN transcript and then RESUME with resumeFromRunId - the merge agent checking the PR itself does not count, and rerunning from scratch cuts a second release branch for the same PRs.',
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
const LOCK_PREFIX = input.lockPrefix || 'devloop'
const MERGE_LOCK = `/tmp/${LOCK_PREFIX}-merge.lock`
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
// deploys: only some repositories have somewhere to deploy TO. The extension ships through store
// review, and integration is published by hand because the npm account has two-factor. Running one
// repository's deploy commands against another would be wrong, so the deploy phase is skipped where
// deploys is false. From the config, a repo deploys when its entry carries a deploy array, and the
// commands in that array are what the deploy step runs.
const REPOS = input.repos
  ? Object.fromEntries(Object.entries(input.repos).map(([name, r]) => [name, {
      path: (r || {}).path || name,
      slug: (r || {}).slug,
      deploy: (Array.isArray((r || {}).deploy) ? (r || {}).deploy : []).filter((c) => trimmed(c)),
      verify: (r || {}).verify,
      deploys: Array.isArray((r || {}).deploy) && (r || {}).deploy.length > 0
    }]))
  : {
      site: { path: 'site', slug: 'your-org/your-app', deploy: [], deploys: true },
      extension: { path: 'extension', slug: 'your-org/your-ext', deploy: [], deploys: false },
      integration: { path: 'integration', slug: 'your-org/your-integration', deploy: [], deploys: false },
      docs: { path: 'docs', slug: 'your-org/your-docs', deploy: [], deploys: false },
    }

const REPO_KEY = trimmed(input.repo)
if (!REPO_KEY) {
  return {
    status: 'error',
    notes: `no repo was supplied. A train runs against ONE repository per run, and this will not ` +
           `choose which one for you: it used to fall back to 'site' silently, so a workspace ` +
           `landing across two repositories lost the smaller one every train under a result that ` +
           `named no repository at all. Pass repo: "<key>" - one of ${Object.keys(REPOS).join(', ')} - ` +
           `and run the train again per repository.`
  }
}
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
const LOCK_TOKEN = trimmed(input.lockToken)
if (!LOCK_TOKEN || !TOKEN_SHAPE.test(LOCK_TOKEN)) {
  const said = LOCK_TOKEN
    ? `lockToken reads [${LOCK_TOKEN}], which is not ${TOKEN_SHAPE} - it is interpolated into a single-quoted shell argument and nothing else can be`
    : 'args carry no lockToken'
  return {
    status: 'error',
    notes: `${said}. Build the dispatch with config.sh --train <repo>, which mints one per ` +
           `launch - stable across a resume of the same run, different on the next - and carries ` +
           `it in the args object it prints. land-train.js will not mint its own and does not ` +
           `fall back to one: a lock step that mints the token reports every value from inside ` +
           `one cached result, so a replayed acquisition agrees with itself and nothing in this ` +
           `script can tell it from a fresh one.`
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

const LEFT_BEHIND = {
  type: 'object',
  required: ['repos'],
  properties: {
    repos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['repo', 'status'],
        properties: {
          repo: { type: 'string', description: 'the repository KEY from the left column of the list you were given, not its owner/name' },
          status: { type: 'string', enum: ['read', 'unreadable'], description: "'read' only when the list command printed something you could read pull request numbers out of - an empty list counts" },
          labelled: { type: 'array', items: { type: 'number' }, description: 'every open labelled pull request number it printed, empty when it printed none' },
          notes: { type: 'string' },
        },
      },
    },
  },
}

const DEPLOYED = {
  type: 'object',
  required: ['status', 'notes'],
  properties: {
    status: { type: 'string', enum: ['deployed', 'partial', 'failed', 'not_needed'] },
    environments: {
      type: 'array',
      description: 'one entry per deploy command you were given, in the order you were given them',
      items: {
        type: 'object',
        required: ['environment', 'revision'],
        properties: {
          environment: { type: 'string', description: 'the label in the deploy command you ran, copied exactly' },
          revision: { type: 'string', description: 'THE REVISION VALUE ALONE, hex characters and nothing else, read back off that host. An empty string when the host did not answer or answered no revision.' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const LIVE = {
  type: 'object',
  required: ['status', 'hosts', 'notes'],
  properties: {
    status: { type: 'string', enum: ['read', 'unreadable'] },
    hosts: {
      type: 'array',
      description: 'one entry per command in the list you were given, whether or not it answered',
      items: {
        type: 'object',
        required: ['environment', 'revision'],
        properties: {
          environment: { type: 'string', description: 'the environment name beside the command in the list you were given, copied exactly. The caller compares each environment separately, so a reply that names the wrong one is a report about a host nobody asked about.' },
          revision: { type: 'string', description: 'THE REVISION VALUE ALONE, as hex characters and nothing else - not the response body it came in, not a branch name, not a version. An empty string when the host did not answer or answered no revision.' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const CLOSED = {
  type: 'object',
  required: ['status', 'closed'],
  properties: {
    status: { type: 'string', enum: ['closed', 'partial', 'none'] },
    closed: {
      type: 'array',
      description: 'one entry per bd close that succeeded, and an empty array when none were - this is keyed by pull request because that is the list you were given',
      items: {
        type: 'object',
        required: ['pr', 'issue'],
        properties: {
          pr: { type: 'number', description: 'the pull request number from the list you were given' },
          issue: { type: 'string', description: 'the tracker id you closed for it' },
        },
      },
    },
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
      detail: `the train declares devloop plugin version ${branch} and origin/master holds ${master}, which is not strictly greater. land-train.sh assigns that number as it builds the train, from what master held then, so this is its own arithmetic to read rather than a branch's guess - the 'version:' line in the build output says what it wrote. No branch is asked to bump ${PLUGIN_MANIFEST} or ${MARKETPLACE_MANIFEST}.`,
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

  bash ${SKILL_DIR}/land-train.sh --repo-path ${REPO_PATH} --slug ${SLUG} --prefix ${LOCK_PREFIX} --max ${MAX}${onlyArg}${suffixArg}

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

function deployCommands() {
  const cmds = REPO.deploy.map((c) => `  cd ${REPO_PATH} && ${trimmed(c)}`)
  return cmds.length
    ? cmds.join('\n\n')
    : `  (${REPO_KEY} records no usable deploy command in its config, so there is nothing here to
  run - say so in 'notes' rather than inventing a deploy)`
}

function verifyCommands() {
  const verify = REPO.verify
  const out = typeof verify === 'string'
    ? (trimmed(verify) ? [`  ${trimmed(verify)}`] : [])
    : verify && typeof verify === 'object'
      ? Object.values(verify).filter((c) => typeof c === 'string' && trimmed(c)).map((c) => `  ${trimmed(c)}`)
      : []
  return out.length
    ? out.join('\n')
    : `  This project records no verify command for ${REPO_KEY}. Work out what the deployed version
  is by whatever means the project offers, and say in 'notes' what you used - a deploy nobody
  confirmed is a deploy that may not have happened.`
}

function readBacks() {
  const verify = REPO.verify
  const targets = REPO.deploy.length
  const commands = typeof verify === 'string'
    ? (trimmed(verify) ? [{ environment: REPO_KEY, command: trimmed(verify) }] : [])
    : verify && typeof verify === 'object'
      ? Object.entries(verify)
        .filter(([, c]) => typeof c === 'string' && trimmed(c))
        .map(([environment, c]) => ({ environment, command: trimmed(c) }))
      : []
  if (!commands.length) {
    return { commands: [], why: `${REPO_KEY} records no verify command in its config, so nothing here can read back what its ${targets} environment(s) are serving` }
  }
  if (commands.length !== targets) {
    return { commands: [], why: `${REPO_KEY} deploys to ${targets} environment(s) and its verify names ${commands.length}, so ${targets > commands.length ? 'at least one environment' : 'an environment that is not deployed to'} can never be confirmed - set one command per environment in repos.${REPO_KEY}.verify, keyed by the environment name` }
  }
  return { commands, why: '' }
}

function readSha(reported) {
  const s = String(reported == null ? '' : reported).trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(s) ? s : ''
}

function samePrefix(a, b) {
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a))
}

function readHosts(back, mergeSha) {
  const served = new Map()
  for (const h of (back && back.hosts) || []) {
    if (!h || typeof h.environment !== 'string') continue
    const revision = readSha(h.revision)
    const seen = served.get(h.environment)
    if (!seen) served.set(h.environment, { revision })
    else if (seen.revision !== revision) served.set(h.environment, { revision: '', contradicted: true })
  }
  const { commands, why } = readBacks()
  const confirmed = []
  const mismatched = []
  const silent = []
  const expected = readSha(mergeSha)
  if (why) return { status: 'unknown', confirmed, mismatched, silent: [why] }
  if (!expected) {
    return { status: 'unknown', confirmed, mismatched, silent: [`${REPO_KEY} recorded no merge sha, so what its hosts reported cannot be compared against anything`] }
  }
  let matched = 0
  let wrong = 0
  let unread = 0
  for (const c of commands) {
    const seen = served.get(c.environment)
    if (seen && seen.contradicted) {
      unread += 1
      silent.push(`${REPO_KEY} ${c.environment} came back twice with two different revisions, and two contradictory answers are not an answer`)
    } else if (!seen || !seen.revision) {
      unread += 1
      silent.push(`${REPO_KEY} ${c.environment} reported no revision`)
    } else if (samePrefix(expected, seen.revision)) {
      matched += 1
      confirmed.push({ environment: c.environment, revision: seen.revision })
    } else {
      wrong += 1
      mismatched.push(`${REPO_KEY} ${c.environment} is serving ${seen.revision.slice(0, 12)}, and what merged was ${expected.slice(0, 12)}`)
    }
  }
  const status = (!back || back.status !== 'read' || unread) ? 'unknown'
    : wrong ? (matched ? 'partial' : 'failed') : 'deployed'
  return { status, confirmed, mismatched, silent }
}

function servingFrom(reported) {
  const out = []
  for (const e of (Array.isArray(reported) ? reported : [])) {
    const environment = trimmed(e && e.environment)
    const revision = readSha(e && e.revision)
    if (environment && revision) out.push(`${environment} ${revision.slice(0, 8)}`)
  }
  return out.join(' ')
}

function livePrompt() {
  const { commands } = readBacks()
  return `Report what revision each host below is serving. Nothing else is asked of you.

Deploy nothing, merge nothing, close nothing, re-run nothing, and change no code. This step only
reads, and what it reads is compared by the caller afterwards.

Run each of these. Each line is one environment of ${REPO_KEY}, its name then its command:
${commands.map((c) => `  ${c.environment}  ${c.command}`).join('\n')}

For each one, report the REVISION VALUE ON ITS OWN - the hex characters and nothing around them.
These endpoints answer with a document; the revision is one field of it, and the rest of the
document is not an answer to this question. Paste the hex, not the body it arrived in.

Report every line above as its own entry, carrying the environment name printed beside it, even
the ones that did not answer. The caller compares each environment separately, so an entry that
names the wrong environment is a report about a host nobody asked about. Report each line once: a
second entry for the same environment contradicts the first and is read as no answer at all.
An empty revision is the correct report for a host that did not answer, that timed out, or that
answered something with no revision in it. Return 'unreadable' as the status when that happened to
any of them, and 'read' when every command answered.

DO NOT WORK OUT WHETHER THIS IS THE RIGHT REVISION, and do not go looking for what it should be.
Whether what a host serves is current is not yours to judge and not yours to know - you have not
been told what merged, deliberately, because a step that knows the expected answer can produce it
without reading anything, and this step exists precisely because something else's word was taken
once already. Report what you read. Guess nothing, and fill nothing in.

DO NOT DEPLOY, whatever you find. A deploy is somebody's decision once they know what is live, and
this step is how they find out.

Never use 2>&1 - it makes some commands fail outright. Use absolute paths, never relative ones.`
}

function deployPrompt(mergeSha, included) {
  return `Deploy master to EVERY environment this repository deploys to. Master is at ${mergeSha},
which carries ${included.length} change(s): ${included.join(', ')}.

${SHELL_FIRST}

  cd ${REPO_PATH}
  git fetch origin --quiet && git log -1 --format='%H' origin/master

Confirm the sha above is what origin/master actually points at BEFORE deploying. If it is not,
stop and report it rather than deploying something else.

Then deploy each environment with these, IN THE ORDER LISTED - the first is the earliest
environment and the last is the one the public reaches:

${deployCommands()}

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

The revision is read back from the running host rather than over ssh on purpose: it needs no
session, and it is the sha the outside world is actually being served.

RUN EACH COMMAND EXACTLY AS WRITTEN, and DO NOT chain the environments with '&&'. Each one wraps
the underlying deploy tool because that tool's exit code does not tell you whether the deploy
happened: on 2026-09-04 a staging deploy finished completely on the server - lock removed, symlink
moved, revisions.log written - and then hung locally for 21 minutes, so the second command never
ran and production silently stayed a release behind with nothing reporting an error. The wrapper
bounds the deploy with a timeout and then decides by reading the sha back off the server, which is
the right answer in both directions: killed but serving the sha is a success, exited 0 but not
serving it is a failure. Do not unwrap one and run the deploy tool directly.

THE WRAPPER'S EXIT CODE IS THE ONE TO TRUST, not the deploy tool's output. If an EARLIER
environment does not exit 0, STOP - report it and do NOT deploy the ones after it, because an
early environment broken with the public one shipped is the same forbidden split mirrored.

EVERY environment, always. A change live in one environment and not another is live in neither as
far as a tester is concerned - which is the whole reason this is one step and not two.

BEFORE YOU START, read every environment back and say what you found:

${verifyCommands()}

If an earlier environment is ALREADY at the merge sha and a later one is not, say so and deploy
only the ones that are behind - do not re-deploy what is already there. Note that this is also
exactly what a train looks like WHILE it is deploying, so if you are not that train, confirm no
other run is in flight before acting on it.

THIS STEP MERGES NOTHING. Everything is already on master.

REPORT A STATUS, AND ONE ENTRY PER ENVIRONMENT WITH THE REVISION YOU READ BACK OFF IT. The caller
gates on that status and closes nothing without it: 'deployed' only when every environment is
serving ${mergeSha}, 'partial' when some are and some are not, 'failed' when none is, and
'not_needed' only when this repository genuinely had nothing to deploy. Do not report 'deployed'
on a deploy command's exit code alone - the revision each host answers with is the evidence, which
is why the read-backs above are part of this step and not a courtesy.

Say in 'notes' what you could not read. An environment you could not confirm is not a deployed
one, and reporting it as deployed closes a tracker issue for work nobody is serving.`
}

function closePrompt(landed, mergeSha, where) {
  return `These changes are on master at ${mergeSha} - ${where}:

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

REPORT ONE ENTRY PER bd close THAT SUCCEEDED, carrying the pull request number it came from and
the tracker id you closed - and an empty list when none did. The caller holds the list above and
nothing else: a pull request you leave out of that list is one it reports as merged, deployed and
NOT confirmed closed, so an issue you closed but did not report reads as an issue sitting in
in_progress with nothing behind it. Say in 'notes' the ones you could not close and why, including
any that were already closed.

Before reporting "no issue found" for any pull request, CHECK YOU READ THE RIGHT ONE: the branch
name you got back should start with devloop/, and the issue id in it should exist in bd. A branch
that looks nothing like devloop/<id> means you read another repository's pull request and the
answer is to retry with --repo, not to report the issue as unidentifiable.`
}

function leftBehindPrompt() {
  const lines = Object.entries(REPOS)
    .filter(([, r]) => r.slug)
    .map(([name, r]) => `  ${name}  ${r.slug}`)
    .join('\n')
  return `This train ran for ONE repository, ${REPO_KEY} (${SLUG}). Say what is still labelled and
open in every configured repository, so the run can report what it never looked at.

Here is every repository this workspace configures, as KEY then owner/name:
${lines}

For each line, run exactly this and nothing else:

  gh pr list --repo <that repository's owner/name> --state open --label lane-verified --json number

RETURN ONE ENTRY PER LINE ABOVE, INCLUDING ${REPO_KEY} ITSELF, and use the KEY from the left column
as 'repo' - not the owner/name, and not a name of your own. A repository you leave out is one the
result cannot account for, and the whole point of this step is that a missing entry and a zero are
the same thing to whoever reads the result and different things in fact.

Report the numbers it printed as 'labelled' and status 'read'. AN EMPTY LIST IS AN ANSWER: report
'read' with an empty 'labelled'.

If a command fails, or prints something you cannot read numbers out of, report status 'unreadable'
for that repository and say why in notes. DO NOT report 'read' with an empty list for a command
that did not work. This step exists because a train that had silently ignored a second repository
returned an empty list of rejections, and a supervisor read that as a clean run while a labelled,
green, reviewed pull request sat untouched.

CHANGE NOTHING. Do not merge, do not label, do not unlabel, do not comment, do not close, do not
rebase, and do not touch any working tree. This step reads and reports.

Never use 2>&1 - it makes some commands fail outright. Use absolute paths, never relative ones.`
}

phase('Lock')
const lock = await agent(
  `Take the serial merge lock so only one lander runs at a time:

  mkdir ${MERGE_LOCK} 2>/dev/null && echo "TAKEN" || echo "HELD"

If it prints HELD, another lander is running. Read who has it, and DO NOTHING ELSE - do not
remove the lock, do not wait for it, do not proceed:

  cat ${MERGE_LOCK}/holder

Report status "held" and what cat printed as 'holder'. If the file is not there yet, report an
empty 'holder' - that is how a lock looks between another run's mkdir and its printf, and this
field is the one ownership is decided from, so a value filled in to have something to say is
worse than none.

If it prints TAKEN, STAMP THE LOCK WITH THE TOKEN THIS RUN WAS LAUNCHED WITH. The holder file used
to say just "lander", which identifies nothing, so the release step could not prove the lock it
was about to delete was its own - it removed a shared resource unconditionally, which is rightly
refused, and every train leaked its lock and needed clearing by hand. Write this one:

  printf '%s\\n' '${LOCK_TOKEN}' > ${MERGE_LOCK}/holder
  cat ${MERGE_LOCK}/holder

THE TOKEN IS ALREADY IN THAT COMMAND AND IS NOT YOURS TO MINT. Do not put $(date +%s), $$, or
anything you compose yourself in its place, and do not ask anybody for one. It is minted per
launch outside this run and the release step is handed the same value, so a token substituted
here is a lock this train cannot give back. A token this step made up would also be stale in
exactly the way this arrangement exists to prevent: replay this answer and every value in it
agrees with itself while the lock on disk belongs to somebody else.

REPORT ONE VALUE: 'holder' is what cat printed back, verbatim and untidied, whatever it says. Do
not correct it to match the token above - the train compares the two and stands down when they
differ, because the file is the fact and what you report is a claim about it. The newline the file
ends with and cat prints back is not a difference: the train ignores whitespace around both.`,
  { schema: { type: 'object', required: ['status', 'holder'], properties: {
      status: { type: 'string', enum: ['taken', 'held'] },
      holder: { type: 'string' } } },
    model: 'haiku', effort: 'low', phase: 'Lock' },
)

const holder = trimmed(lock && lock.holder)
if (!lock || lock.status !== 'taken') {
  return { status: 'held', notes: `Another lander holds ${MERGE_LOCK}${holder ? `, whose holder file reads [${holder}]` : ''}. Nothing was done.` }
}

if (holder !== LOCK_TOKEN) {
  const unproven = `LEAKED - the lock step reported taken, but ${MERGE_LOCK}/holder reads [${holder}] against a token of [${LOCK_TOKEN}], so this train cannot prove the lock is its own. Nothing was built and nothing was removed. Read ${MERGE_LOCK}/holder: if it names a run that has finished, clear it; if it names another lander, it is theirs and they give it back themselves.`
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
let deployed = 'not_attempted'
let closed = 'not_attempted'
let unclosed = []
let heldBack = []
const perRepo = {}
let released = null
let lockState = `LEAKED - the release step never reported. Read ${MERGE_LOCK}/holder before touching anything.`

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
  let servingText = ''
  if (REPO.deploys) {
    phase('Deploy')
    const d = await agent(deployPrompt(lastSha, landed), { phase: 'Deploy', label: 'deploy', schema: DEPLOYED })
    deployed = (d && d.status) || 'unknown'
    servingText = servingFrom(d && d.environments)

    if (deployed === 'not_needed') {
      log(`the deploy step reported not_needed, but ${REPO_KEY} configures ${REPO.deploy.length} deploy command(s) - that is the config's answer to give, not the step's, so the deploy is unknown until a host says otherwise`)
      deployed = 'unknown'
    }

    if (deployed === 'unknown') {
      const { commands, why } = readBacks()
      if (!commands.length) {
        log(`the deploy step reported nothing, and reading the hosts back cannot settle it either, so the deploy stays unknown and the issues stay open until a person reads a host:\n    ${why}`)
      } else {
        const back = await agent(livePrompt(), { schema: LIVE, model: 'haiku', effort: 'low', phase: 'Deploy', label: 'deploy-check' })
        const read = readHosts(back, lastSha)
        deployed = read.status
        if (read.confirmed.length) servingText = read.confirmed.map((c) => `${c.environment} ${c.revision.slice(0, 8)}`).join(' ')
        log(`the deploy step reported nothing, so the hosts were read back instead - deploy is ${deployed}${back && back.notes ? `\n    ${back.notes}` : ''}`)
        for (const line of [...read.mismatched, ...read.silent]) log(`    ${line}`)
      }
    }
    log(`deploy: ${deployed}${servingText ? ` ${servingText}` : ''}`)
  } else {
    deployed = 'not_needed'
    log(`${REPO_KEY} has no deploy target - merged to master and stopping there`)
  }

  if (deployed === 'deployed' || deployed === 'not_needed') {
    phase('Close')
    const where = deployed === 'not_needed'
      ? `${REPO_KEY} has no deploy to be live in, so these are closed on the merge alone`
      : `deployed${servingText ? ` - ${servingText}` : ''}`
    const c = await agent(closePrompt(landed, lastSha, where), { model: 'sonnet', phase: 'Close', label: 'close', schema: CLOSED })
    closed = (c && c.status) || 'unknown'
    const reported = new Set(((c && c.closed) || []).map((e) => Number(e && e.pr)).filter((n) => Number.isInteger(n)))
    unclosed = landed.filter((n) => !reported.has(n))
    if (unclosed.length) {
      log(`CLOSE ${closed === 'unknown' ? 'UNKNOWN - that step reported nothing, which is not the same as a refusal' : closed} - these landed and nothing confirmed the issue behind them was closed, so they are sitting in_progress with nothing reporting it: ${unclosed.map((n) => `${SLUG}#${n}`).join(' ')}\n    Check them with bd show before closing anything by hand.${c && c.notes ? `\n    ${c.notes}` : ''}`)
    } else {
      log(`closed ${reported.size} issue(s) - ${((c && c.closed) || []).map((e) => `${SLUG}#${e.pr} ${trimmed(e.issue) || '(no id reported)'}`).join(', ')}`)
    }
  } else {
    heldBack = [...landed]
    closed = 'not_attempted'
    const waiting = heldBack.map((n) => `${SLUG}#${n}`).join(' ')
    if (deployed === 'unknown') {
      log(`deploy UNKNOWN - nothing reported whether it happened and reading the hosts back did not settle it either. THIS IS NOT A FAILURE and must not be re-run on the strength of this line. What settles it: what each host is serving, against the sha that merged.\n${readBacks().commands.map((c) => `    ${c.environment}  ${c.command}`).join('\n') || `    ${readBacks().why}`}\n    merged: ${lastSha}\n    left open until somebody says: ${waiting}`)
    } else {
      log(`deploy ${deployed} - nothing was closed, and these stay open until it is live: ${waiting}\n    merged: ${lastSha}. Read what each host is serving against that sha before closing anything by hand.`)
    }
  }
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

const survey = await agent(leftBehindPrompt(), {
  schema: LEFT_BEHIND, model: 'haiku', effort: 'low', phase: 'Close', label: 'left-behind',
})
const answered = new Map()
for (const entry of (survey && Array.isArray(survey.repos)) ? survey.repos : []) {
  const key = trimmed(entry && entry.repo)
  if (key && REPOS[key]) answered.set(key, entry)
}
for (const [name, r] of Object.entries(REPOS)) {
  const mine = name === REPO_KEY
  const taken = mine ? landed.length : 0
  const entry = answered.get(name)
  const unsurveyed = (why) => ({ slug: r.slug || null, train: mine, surveyed: null, taken, left: null, leftPrs: [], relaunch: null, why })
  if (!r.slug) {
    perRepo[name] = unsurveyed('no slug is configured for this repository, so nothing could be surveyed in it')
    continue
  }
  if (!entry) {
    perRepo[name] = unsurveyed('the survey step reported nothing for this repository, so what is labelled in it is unknown')
    continue
  }
  if (entry.status !== 'read' || !Array.isArray(entry.labelled)) {
    perRepo[name] = unsurveyed(`the survey step could not read this repository: ${trimmed(entry.notes) || 'it reported ' + (trimmed(entry.status) || 'nothing') + ' and said no more'}`)
    continue
  }
  const unreadable = entry.labelled.filter((n) => !Number.isInteger(n))
  if (unreadable.length) {
    perRepo[name] = unsurveyed(`the survey step reported ${unreadable.map((n) => JSON.stringify(n)).join(', ')} where a pull request number belongs, so what is labelled in this repository cannot be counted`)
    continue
  }
  const left = entry.labelled.filter((n) => !(mine && landed.includes(n)))
  const many = left.length === 1 ? 'it' : 'them'
  perRepo[name] = {
    slug: r.slug,
    train: mine,
    surveyed: taken + left.length,
    taken,
    left: left.length,
    leftPrs: left,
    relaunch: (!mine && left.length) ? `run config.sh --train ${name} and dispatch the object it prints` : null,
    why: !(mine && left.length) ? null
      : outcome.stopped
        ? `this train stopped (${outcome.stopped}) before taking ${many}; the label stands`
        : `still labelled and open in ${name} when this train finished - in rejected or stranded above if this run saw ${many}, otherwise labelled after the build surveyed the queue and queued for the next train for ${name}; the label stands either way`,
  }
}
for (const [name, a] of Object.entries(perRepo)) {
  const count = `${a.left} labelled pull request${a.left === 1 ? '' : 's'} left (${a.leftPrs.map((n) => `${a.slug}#${n}`).join(', ')})`
  if (a.surveyed === null) {
    log(`${name} was NOT surveyed - ${a.why}`)
  } else if (a.relaunch) {
    log(`${name}: ${count} - ${a.relaunch}`)
  } else if (a.left) {
    log(`${name}: ${count} - ${a.why}`)
  }
}
} finally {
released = await agent(
  `Release the serial merge lock. This runs however the train ended - merged, stopped or failed -
because a lock left behind stands down every train after it for no reason.

RUN THIS ONE COMMAND, EXACTLY AS IT STANDS, AND NOTHING ELSE:

  bash ${SKILL_DIR}/release-lock.sh --lock ${MERGE_LOCK} --token '${LOCK_TOKEN}'

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
  lockState = `not_mine - ${MERGE_LOCK}/holder did not hold ${LOCK_TOKEN}, so nothing was removed and nothing should be`
  log(`${lockState}.\n    ${released.notes || 'the script reported NOT_MINE and says what the holder file read instead'}`)
} else if (released && released.status === 'already_gone') {
  lockState = `already_gone - ${MERGE_LOCK} was not there to release`
  log(`${lockState}. Something removed this run's lock while it was working, so another train may have been running beside it.\n    ${released.notes || ''}`)
} else {
  lockState = `LEAKED - ${MERGE_LOCK} still held ${LOCK_TOKEN} after the release step, or the step answered nothing. Check ${MERGE_LOCK}/holder still reads ${LOCK_TOKEN} before removing it - if it reads anything else, another train has it and it is not yours.`
  log(`${lockState}\n    ${(released && released.notes) || 'the release agent returned nothing'}`)
}
}

return {
  repo: REPO_KEY,
  slug: SLUG,
  repos: perRepo,
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
  deployed,
  closed,
  unclosed,
  heldBack,
  mergeSha: lastSha,
  stopped: outcome.stopped || null,
  notes: outcome.notes || null,
  lock: lockState,
}
