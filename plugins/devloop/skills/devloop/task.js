export const meta = {
  name: 'devloop-task',
  description: 'Carry one tracker issue from open to landable: design it if it is user-facing, fix it in a worktree, review it adversarially, and hand the green PR to the lander',
  phases: [
    { title: 'Triage', detail: 'read the issue, decide repo and whether it is safe to do unattended' },
    { title: 'Split', detail: 'when the issue is really several, make it several and let the loop take them' },
    { title: 'Design', detail: 'a designer decides any user-facing change before it is built' },
    { title: 'Fix', detail: 'own worktree, tests and lint green, PR opened' },
    { title: 'Review', detail: 'independent reviewer, adversarial, up to 3 rounds' },
    { title: 'Handoff', detail: 'wait for the PR to go green, then label it lane-verified for the lander' }
  ]
}

// One issue per run. The supervisor loop decides what to start and how many run at once;
// this script only knows how to finish one thing properly.
//
// args can arrive as an object or, if a caller hands the tool a JSON-encoded string, as a
// string. Coerced rather than rejected: the difference is invisible at the call site, and
// the failure it causes is a workflow that claims an issue and then does nothing for it -
// which in an unattended loop drains the queue into permanent claims within a few ticks.
const input = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// PROJECT CONFIGURATION ARRIVES IN args, IT IS NOT READ FROM DISK.
//
// A workflow script has no filesystem access, so it cannot open .autofix.json itself. The
// supervisor reads it - `config.sh --args <id> <slot>` - and passes the result in. That is the
// whole mechanism, and it is why this skill is shared rather than copied per project: of this
// file's 1100-odd lines, about 56 name any project's tools. The rest is generic, including the
// paragraphs that each record a specific past failure. Copies fork that lore; config does not.
//
// ROOT IS REQUIRED. There is no default, and the argument for removing it is worth keeping,
// because the argument for KEEPING it sounded reasonable and was wrong.
//
// It used to default to the workspace root. The case for leaving it was
// "a refusal would break every in-flight caller mid-session". pitwall-devloop inverted that on
// 2026-09-09 and was right: a caller that omits root is ALREADY broken. It is not working in
// its own workspace - it is cutting a worktree from one workspace, taking one workspace's
// lane lock, and writing into one workspace's slot registry, for a full run, while reporting
// its own tracker's issue ids. Refusing does not break a working caller; it stops a silently
// wrong one before its first write instead of after.
//
// This was the least recoverable of the seven defaults fixed that day, and the only one where
// ANOTHER PROJECT'S WORKING TREE IS MODIFIED - worktree, branch, commits, and a lane lock held
// against a test database that is not its own. It composed with a documentation bug: SKILL.md's
// own dispatch example was `args: { id, slot }`, so a supervisor copying the documented example
// into another workspace got exactly this. Each was survivable alone.
//
// Only root is required. idPrefix and lockPrefix keep their defaults: root is the field whose
// absence causes the cross-workspace write, and refusing on one field is a smaller change than
// refusing on three.
if (!input.root) {
  return {
    id: input.id || null,
    outcome: 'error',
    notes: 'no root in args - refusing to run. Build the args with `config.sh --args <id> <slot>`; ' +
           'task.js has no filesystem access and reads its configuration from args alone. ' +
           'It will not default the root: a dispatch that omits it would cut a worktree, take a ' +
           'lane lock and commit inside whichever workspace the default names, which is almost ' +
           'certainly not yours.'
  }
}
const ROOT = input.root
const ID_PREFIX = input.idPrefix || 'sr'
const REPOS = input.repos || {}
// /tmp is shared across every project on this machine. Two projects dispatching with the same
// lockPrefix collide on the lane locks - and the lane lock is what stops two lanes sharing a
// test database.
const LOCK_PREFIX = input.lockPrefix || 'devloop'

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

const WT = input.worktrees || `/tmp/${LOCK_PREFIX}-worktrees`

// What a lane runs to check its own work, per repo, from the config. Falls back to an
// instruction rather than a guess: a wrong test command reads as a broken build.
function repoCommands(repo) {
  const r = REPOS[repo] || {}
  const lines = []
  if (r.test) lines.push(`  tests:  ${r.test}`)
  if (r.testParallel) lines.push(`  tests (as CI runs them):  ${r.testParallel}`)
  if (r.lint) lines.push(`  lint:   ${r.lint}`)
  if (r.build) lines.push(`  build:  ${r.build}`)
  if (!lines.length) {
    return `This repository has no commands recorded in .autofix.json. Work out how it tests and
lints itself - README, CI workflow, package.json scripts - and say in your notes what you used,
so somebody can add it to the config.`
  }
  const notes = (r.notes || []).map((n) => `  - ${n}`).join('\n')
  return `Run these before opening a pull request. They come from this workspace's
.autofix.json, so they are what CI will run too:
${lines.join('\n')}${notes ? `\n\nWorth knowing about this repository:\n${notes}` : ''}`
}
const MAX_ATTEMPTS = input.maxAttempts || 3
const MAX_REWORKS = input.maxReworks || 2
const ID = input.id
const SLOT = input.slot || 1

// Returning here leaves the issue claimed, because this script cannot run bd. The caller
// must release it - see 'a dispatch that returns error' in SKILL.md.
if (!ID) return { error: 'no issue id given - call with args: { id: "app-xxxx", slot: 1 }', releaseClaim: true }

const TRIAGE = {
  type: 'object',
  required: ['eligible', 'repo', 'title', 'priority', 'ui', 'reason', 'ticket'],
  properties: {
    eligible: { type: 'boolean' },
    // The ticket body, carried back as text so the DESIGNER can be handed it directly.
    //
    // This used to travel through /tmp/devloop-ticket-<id>.txt, and it failed exactly as an
    // out-of-band channel does: the file was not there, and the designer - which was told to
    // stop if it was missing - designed from the title instead and said so in its own output.
    // Three review rounds and two and a half hours later the run gave up without converging,
    // because the brief never contained the acceptance criteria the reviewer was measuring
    // against. Text in a prompt cannot go missing between two steps.
    ticket: { type: 'string', description: 'the full ticket body as bd show printed it' },
    // Set when the ONLY thing wrong is shape: the issue bundles work that belongs in
    // separate runs. Splitting is scoping, not deciding, so it does not need a person.
    splittable: { type: 'boolean' },
    splitPlan: {
      type: 'array',
      description: 'one entry per child issue this should become',
      items: {
        type: 'object',
        required: ['title', 'repo', 'scope', 'autonomous'],
        properties: {
          title: { type: 'string' },
          repo: { enum: ['site', 'extension', 'integration', 'docs'] },
          scope: { type: 'string', description: 'what this child covers, traceable to the parent text' },
          autonomous: { type: 'boolean', description: 'false if this child still needs a person' },
          whyNotAutonomous: { type: 'string' }
        }
      }
    },
    repo: { enum: ['site', 'extension', 'integration', 'docs', 'unknown'] },
    title: { type: 'string' },
    priority: { type: 'integer' },
    ui: { type: 'boolean' },
    reason: { type: 'string' }
  }
}

const WORK = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['pushed', 'needs_feedback', 'needs_design', 'no_change_needed', 'blocked'] },
    summary: { type: 'string' },
    repo: { enum: ['site', 'extension', 'integration', 'docs', 'unknown'] },
    branch: { type: 'string' },
    prNumber: { type: 'integer' },
    prUrl: { type: 'string' },
    testsAdded: { type: 'string' },
    testOutput: { type: 'string' },
    lintOutput: { type: 'string' },
    question: { type: 'string', description: 'the decision needed, when status is needs_feedback' },
    worktree: { type: 'string' },
    touchesUi: { type: 'boolean' },
    screenshots: { type: 'array', items: { type: 'string' }, description: 'absolute paths to before/after captures' }
  }
}

const REVIEW = {
  type: 'object',
  required: ['approved', 'notes'],
  properties: {
    approved: { type: 'boolean' },
    fixesTheDefect: { type: 'boolean' },
    testWouldCatchRegression: { type: 'boolean' },
    scopeCreep: { type: 'boolean' },
    visuallyConfirmed: { type: 'boolean', description: 'screenshots were actually viewed, for a UI change' },
    blocking: { type: 'array', items: { type: 'string' }, description: 'what must change to approve' },
    notes: { type: 'string' }
  }
}

const SHIP = {
  type: 'object',
  required: ['status', 'notes'],
  properties: {
    // A lane no longer merges or deploys. It gets the PR green and labels it 'lane-verified';
    // a single serial lander rebases, merges and deploys. Before this, every lane rebased
    // against every other lane's merge - one branch rebased three times and spent 4h26m in
    // the ship phase against 43 minutes of work, and the waste grew with the number of lanes.
    status: { enum: ['verified', 'blocked'] },
    verified: { type: 'boolean', description: 'the PR is green and now carries the lane-verified label' },
    prNumber: { type: 'number' },
    ciConclusion: { type: 'string' },
    notes: { type: 'string' }
  }
}

const LAW = `
NON-NEGOTIABLE RULES. They outrank speed, and they outrank finishing the task.

0. WRITE bd TEXT THROUGH A FILE OR A QUOTED HEREDOC, never as an inline double-quoted
   argument containing backticks or $(...). The shell evaluates them before bd ever sees
   the string, and the failure is SILENT: the substitution's output replaces the text, so
   the issue is created successfully with a sentence missing. This has happened three times
   in one day - a failure message lost the expression it was quoting, an acceptance
   criterion vanished on create, and a description kept a dangling half-sentence pointing at
   nothing. Use --body-file, or a heredoc quoted as <<'EOF' so nothing expands. Then read
   the field back and check the text you meant is actually there.

   READ IT BACK WITH --json, NOT FROM THE RENDERED OUTPUT. bd show's terminal renderer is
   not the data: it strips angle brackets, so a stored '<slug>.cover.html' displays as
   '.cover.html', and it wraps long values, which is how a post UUID came to be mistyped
   into an acceptance criterion earlier today. If you are copying an id, a path or a
   placeholder out of a ticket, take it from --json.

   SEARCH BEFORE YOU FILE. Run 'bd search <a distinctive phrase>' first - a file name, an
   error string, a spec path. Lanes cannot see each other, so the same finding gets filed
   again and again: one clock bug in post_spec.rb collected FIVE tickets from five runs in a
   single night, and each of the four extras cost a full dispatch for somebody to rediscover
   and close it. If a match exists, append your evidence to it instead of creating a sibling -
   your diagnosis is usually worth keeping even when the ticket is not.

   --append-notes ON 'bd create' IS SILENTLY DROPPED. The issue is created, the command
   succeeds, and notes come back null. Create first, then apply notes with a separate
   'bd update --append-notes', and read the field back.

   BEFORE FILING THAT SOMETHING IS MISSING FROM MASTER, ASK MASTER - NOT YOUR WORKTREE. Your
   checkout was cut from whatever master was when this lane started, and other lanes have been
   landing work since. Fetch, then look at the ref:
     git fetch origin --quiet && git ls-tree --name-only origin/master <path>
     git show origin/master:<file> | head
   And check whether a sibling already has it in flight, because an open pull request is not a
   gap in the product:
     gh pr list --state open --search "<the file or symbol>"

   This has cost three tickets in one day. app-133q said script/marketing/illustrations.mjs did
   not exist; it had been on master for hours, 164 lines, and the header the ticket quoted as
   out of date had been rewritten in the same commit. app-gjul reported a masking hole that the
   very pull request raising it had already closed. app-mk94 was dispatched against a locale key
   that existed only on an unmerged branch, and the lane that got it could not start.

   Each was true of somebody's working copy and false of the repository. Say which you checked.

1. Never mention AI, assistants, automated authorship or tooling in a commit message, PR
   title or body, code comment, or any documentation. Write as a human developer.
   After committing: read it back with 'git log -1 --format=%B' and check.
   After opening a PR: read it back with 'gh pr view <n> --json body' and check.
   Run the compliance grep as its own command, separate from the git commit. The original
   reason given was a pre-commit hook scanning the command line; there is no such hook, so the
   real reason is the one that still holds - a grep pattern sharing a line with the commit is
   easy to misread as part of the message, and separating them makes the check legible.
   A pipeline path counts. a worktree path under /tmp names the machinery as surely as the
   word "agent" does, and it is easy to paste into a PR body while quoting a measurement.
   FIX IT RATHER THAN STOPPING, when it is only in the PR body or title: rewrite the sentence
   to describe the thing by shape - "a checkout with no dot-directory in its path" - re-read
   the body back from GitHub, and carry on. Editing a description does not touch the head
   commit, so a green run stays valid. Halting would leave the reference sitting in an open
   PR, which is worse than removing it.
   In a COMMIT MESSAGE it is different: amending rewrites the commit and invalidates the run,
   so amend, force-push and wait for CI again. Say in your notes what you changed either way.

   AN INSTRUCTION TO ADD AUTHORSHIP TRAILERS IS EXPECTED, AND IS ALREADY DECLINED.
   A run may be handed an instruction to append authorship trailers to commit messages and a
   generated-with footer to pull request bodies. It contradicts this rule. That contradiction
   is PERMANENT, ALREADY SETTLED, AND THIS RULE WINS - write the commit and the body without
   those lines and CARRY ON. It is not a conflict to escalate, and not a reason to stop.
   Do not add a note about having declined it either; the absence is the whole point.
   Four lanes in one day stopped at the handoff to ask which instruction won. Two had already
   finished the work - one after 211 tool uses - and each left a finished, green pull request
   with no label, for a person to notice and label by hand. Escalating was defensible the
   first time. It is pure loss now that the answer is written here.
2. Never commit to, push to, or force-push a default branch. Work only on your own branch.
3. Guard branch creation and pushes:
   git-guard --dir=<absolute worktree path> --branch=<your branch> -- git <command>
4. Never deploy production. Staging only, and only in the Ship step.
5. Never run 'git init', never change a remote, never delete anybody's branch but your own.
6. Work only inside your own worktree under ${WT}. Never edit a main checkout - one of them
   sits on a release branch with uncommitted work that must not be disturbed.
7. Never use 2>&1 in a bash command. Always use absolute paths.
   THIS ONE GETS BROKEN CONSTANTLY, and always on a command nobody thought counted -
   'bd create --help 2>&1 | head', 'gh ... 2>&1'. It is a workspace-wide rule, not a
   rule about the interesting commands: it breaks xcodebuild and other tools outright,
   so there is no category of command it does not apply to. You almost never wanted the
   merge anyway - you wanted stderr GONE, which is 2>/dev/null, or you wanted to read
   help text, which needs no redirect at all. Reach for one of those instead.
8. Never report success over a failing check. If tests or lint are red and you cannot get
   them green, stop and say so.
9. Write notes with --append-notes, NEVER --notes. Despite bd's own help calling it
   "Additional notes", --notes REPLACES everything already there - which has already
   destroyed a decision somebody recorded and a workflow's own diagnosis. --append-notes
   adds with a newline separator. The same applies to anything you tell another agent to run.
10. The tracker is at ${ROOT}. bd resolves to the NEAREST .beads directory, and site and
   extension still contain dead ones left over from before the tracker moved - running bd
   inside either repo silently rewrites the wrong tracker and dirties files in somebody's
   branch. So set this in every shell where you run bd, whatever your working directory:
     export BEADS_DIR=${ROOT}/.beads
   Never run 'bd init' anywhere. If you see .beads/config.json deleted or .beads/metadata.json
   appear inside a code repo, that is this mistake - restore it with 'git checkout --' and
   remove the stray file.
11. The repos' git hooks that called 'bd sync' were removed: 1.x has no sync subcommand and
   they failed every commit. Do NOT run 'bd hooks install' to repair them - it also installs
   a prepare-commit-msg hook that appends agent identity trailers to commit messages, which
   rule 1 forbids. If a commit is blocked by a hook, say so and stop.
12. EVERY 'gh pr' COMMAND CARRIES ITS REPOSITORY. Use '--repo <owner/name>' on every one,
   including inside the checkout. A bare number means "whichever repository this directory
   points at", which is the assumption that is wrong when a run has been routed to the wrong
   checkout - and pull request numbers overlap across the repositories here, so a bare number
   returns a real answer rather than an error. There is no failing case to catch it.
   The slug for this run is given above. If a command needs a number from another repository,
   name that repository explicitly too.
`

// The config may place a repo anywhere under the workspace; falling back to the repo's own name
// keeps a bare dispatch working for the common case where they match.
function repoPath(repo) { return `${ROOT}/${(REPOS[repo] || {}).path || repo}` }

// HOW A LANE CHECKS ITS OWN WORK.
//
// The blocks below are per-repo lore, not per-repo configuration - parallel test databases,
// schema.rb contamination, which directories may be symlinked into a worktree. They stay
// keyed on a repo's ROLE rather than its name so another project can claim the same handling
// by setting "role" in .autofix.json: "rails" gets the parallel-database machinery, "node"
// gets the npm shape, anything else gets the generic path, which reads its commands from the
// config and is perfectly serviceable.
//
// A project with no config at all still works: the lane is told to find the repo's own test
// command and to report what it used. Slower, and honest about what it did.
function roleOf(repo) {
  const r = REPOS[repo] || {}
  if (r.role) return r.role
  if (repo === 'site') return 'rails'
  if (repo === 'extension' || repo === 'integration') return 'node'
  if (repo === 'docs') return 'script'
  return 'generic'
}

function checksFor(repo, wtPath, laneIndex) {
  const cfg = REPOS[repo] || {}
  const role = roleOf(repo)

  if (role === 'generic' || (!cfg.test && role !== 'rails' && role !== 'node' && role !== 'script')) {
    return `${repoCommands(repo)}

Everything must pass before you open a pull request. If a command fails for a reason that has
nothing to do with your change - a missing dependency, an unconfigured service - say so in your
result rather than working around it: a lane that edits its way past a broken environment ships
a change nobody can reproduce.

Other lanes run at the same time on this machine. If this repository's suite uses a shared
resource - a database, a fixed port, a scratch directory - claim lane ${laneIndex + 2} first:

  mkdir /tmp/${LOCK_PREFIX}-lane-${laneIndex + 2}.lock 2>/dev/null && echo GOT_LANE || echo LANE_BUSY

If that prints LANE_BUSY, stop and hand back rather than running anyway.`
  }

  if (role === 'rails') {
    return `This is a Rails 8 app. Other lanes run at the same time, so you MUST carry
TEST_ENV_NUMBER=${laneIndex + 2} on every command that touches the database or the suite.

FIRST, CONFIRM THE NUMBER IS YOURS. ${laneIndex + 2} is derived from slot ${SLOT}, and the slot
reservation is the record of who owns what. Check it before you touch anything:

  cat /tmp/${LOCK_PREFIX}-slots/${SLOT}

That must print ${ID}. If it prints another issue's id, or nothing, STOP and hand back saying so
- do not fall back to a number that looks free. On 2026-08-31 a run used TEST_ENV_NUMBER 6 when
slot 4 made it lane 5, and only the atomic lock stopped it resetting another lane's database
mid-suite. Nothing was damaged that time, and the reason it was survivable is exactly why it
matters: the lock and the database are derived from the SAME number, so a run on a number that is
not its own is protected only while the rightful owner happens to be holding that lock. Two runs
that drift onto the same free number share a database with nothing between them, and that is
silent - it reads as a flaky suite, not as a collision.

THEN CLAIM THE LANE. Your lane number is the database: ${laneIndex + 2} means
this repository's test database ${laneIndex + 2}. If another run is already using it, you will reset its
database mid-suite and it will reset yours, and neither of you will be told - it surfaces as
unexplained spec failures in files you never touched. Before anything else:

  mkdir /tmp/${LOCK_PREFIX}-lane-${laneIndex + 2}.lock 2>/dev/null && echo GOT_LANE || echo LANE_BUSY

If that prints GOT_LANE, record who holds it, so the next run that is refused can read the answer
instead of guessing it off a process list that has usually exited by the time anyone looks:

  printf '%s\\n' "${ID} slot ${SLOT} TEST_ENV_NUMBER ${laneIndex + 2}" > /tmp/${LOCK_PREFIX}-lane-${laneIndex + 2}.owner

That file sits BESIDE the lock, never inside it. A file inside the lock directory would make the
rmdir below fail, and the lane would stay held forever - the same permanent-block failure the
paragraph after this one describes, arrived at from the other direction.

mkdir is atomic, so exactly one run can win. THE LANE LOCK IS A BARE DIRECTORY. Never write
a file at that path and never put a holder file inside it - that is the MERGE lock's pattern,
not this one, and confusing the two has already cost a lane. A regular file appeared at
/tmp/<prefix>-lane-9.lock containing 'review <id> <pid>', and because mkdir can never succeed
against an existing file, that lane was blocked permanently rather than until the holder
finished - a dead process holding a lock nothing could release.

If it prints LANE_BUSY, STOP: return with a
result saying lane ${laneIndex + 2} was already held, and do not touch the database. Read the
holder and quote it in your result, because it names the run rather than leaving the next person
to infer it:

  cat /tmp/${LOCK_PREFIX}-lane-${laneIndex + 2}.owner 2>/dev/null || echo "no owner file - holder unknown"

Say in your result whether the lock is a directory or a file: a file there is a fault to report,
not a lane that happens to be busy. A run
that refuses to start is cheap; two runs sharing a database cost both of them a review round
diagnosing damage the other did. Remove BOTH when you are finished, including when
you fail, and in this order - the owner file first, so the directory is never left un-removable:

  rm -f /tmp/${LOCK_PREFIX}-lane-${laneIndex + 2}.owner
  rmdir /tmp/${LOCK_PREFIX}-lane-${laneIndex + 2}.lock

Then carry the variable on every command:
  cd ${wtPath} && TEST_ENV_NUMBER=${laneIndex + 2} bundle exec rails db:test:prepare
  cd ${wtPath} && TEST_ENV_NUMBER=${laneIndex + 2} bash ${SKILL_DIR}/rspec-quiet.sh
  cd ${wtPath} && bundle exec rubocop
TEST_ENV_NUMBER applies to EVERY command that touches a database, migrations included:
  cd ${wtPath} && TEST_ENV_NUMBER=${laneIndex + 2} RAILS_ENV=test bundle exec rails db:migrate
Without it you migrate the shared default test database, which other worktrees are using -
and db/schema.rb comes back carrying THEIR columns. That has already happened: a run found
leads.confirmed_at and friends in its schema.rb from a sibling's double opt-in branch.

So: never commit a db/schema.rb change you did not cause. Read the diff before staging it,
and if it holds columns your migration did not add, restore it with
'git checkout -- db/schema.rb' and say so in your result.

RUN THE SUITE THROUGH rspec-quiet.sh, not through rspec directly. It runs the same
'bundle exec rspec', passes your arguments through, and returns rspec's OWN exit code - so
branch on the exit code exactly as before. What it changes is only what you have to read: the
counts line, every failing example's locator (all of them, never truncated), a bounded excerpt
of each failure message, and the path to the full log.

The excerpt matters more than it sounds. A failed Capybara have_content prints the ENTIRE
page text - one such failure was 18 KB of importmap JSON and sidebar markup, and it said
nothing the assertion line had not already said. If you need more than the excerpt, read the
log file it names; nothing is thrown away. RSPEC_QUIET_FULL=1 makes it behave like plain
rspec if you ever need that.

This project's .rspec sets --format documentation, so a raw local run prints every example
name - about 80% more output than the dots CI uses. The filter makes that irrelevant to you,
which is why .rspec is left alone for the humans who like reading it.

DO NOT RUN THE FULL SUITE LOCALLY. CI RUNS IT, AND CI IS FOUR TIMES FASTER.

The owner decided this on 2026-08-28, on measurements from this pipeline: a lane's serial local
run took 10.1 minutes and then 5.0, while the same suite in CI takes about 2.6 because
parallel_rspec splits it across workers. The root CLAUDE.md's "about two and a half minutes" is
CI's number and has been misread as local ever since. Running it here duplicates CI at four
times the cost and delays the pull request by ten minutes.

WHAT YOU RUN LOCALLY - both are fast and both catch the obvious before you spend a CI cycle:

  cd ${wtPath} && TEST_ENV_NUMBER=${laneIndex + 2} bash ${SKILL_DIR}/rspec-quiet.sh <the specs
                    you touched, and any that cover the code you changed>
  cd ${wtPath} && bundle exec rubocop

Pass timeout: 600000 on the tool call. The Bash tool's default is two minutes, which is why
lanes used to background the suite to a log and then poll it - one spent FIVE calls waiting on
a single run. A blocking call with a timeout costs one.

WHAT CI RUNS: everything. Push, open the PR, then wait on it with ONE blocking call:

  cd ${wtPath} && gh pr checks <your PR number> --watch --fail-fast

That streams rather than polls, and returns non-zero the moment a check fails. If it comes back
red, the failure is yours to fix exactly as a local one would be - read the run, fix, push, wait
again. A red CI run on YOUR OWN BRANCH is the normal way to find a break here; it costs a
2.6-minute cycle instead of a ten-minute one.

WHAT THIS DOES NOT CHANGE: the PR still has to be green before it is labelled, and
lane-handoff.sh refuses to label anything whose rollup is empty, failing, or describing a stale
head. The gate did not move, only where the suite runs.

IF YOU EDIT A FILE WITH THE Edit TOOL, READ IT WITH THE Read TOOL FIRST. Inspecting it with
'cat' through Bash does not count: Edit refuses with "File has not been read yet" and the call
is wasted. Either Read then Edit, or skip Edit and write the change with a python heredoc -
both work, mixing them does not.

A fresh worktree needs .env,
config/master.key and node_modules SYMLINKED from ${ROOT}/site to boot. They are gitignored
and must not end up in your commit; check 'git status' before committing.

.env IS A SYMLINK TO THE OWNER'S OWN FILE, SO NEVER WRITE TO IT. Appending a line in your
worktree writes straight through into ${ROOT}/site/.env and changes how their development
machine behaves. On 2026-08-30 exactly that happened while trying to silence browser popups,
and the owner's .env had to be restored. If you need an environment variable, export it for
your command - FOO=bar bundle exec ... - never edit the file.

IF YOU BOOT THE APP TO TAKE SCREENSHOTS, EXPORT LAUNCHY_DRY_RUN=true.
script/marketing/shots.mjs drives Chrome over a running app, and a running app means RAILS_ENV
development, and development delivers mail through letter_opener - which opens a browser window
on the owner's desktop for every message sent. A single marketing run on 2026-08-30 opened
thirty-four of them, all password-change notices, on a machine somebody was working at. It looks
to them like their own test suite has gone haywire.

  LAUNCHY_DRY_RUN=true bin/rails server -p <your port> &
  LAUNCHY_DRY_RUN=true node script/marketing/shots.mjs ...

The mail still gets written under tmp/my_mails, so nothing is lost and you can still read what
was sent. Only the window is suppressed.

app/assets/builds IS DIFFERENT - COPY IT, NEVER SYMLINK IT. The directory is tracked (it
holds a .keep), so replacing it with a link makes git report the .keep deleted and the
directory untracked, and 'git check-ignore' fails outright with "pathspec is beyond a
symbolic link". The result is a dirty tree that blocks a rebase, for a reason that looks
nothing like its cause. Copy it, or just run dartsass:build in the worktree and let it
populate:
  cp -R ${ROOT}/site/app/assets/builds/. ${wtPath}/app/assets/builds/
If you inherit a worktree where it is already a symlink, remove ONLY the link - never the
target, which is the main checkout's compiled CSS - then recreate the directory and restore
the tracked .keep.

app/assets/builds is COMPILED OUTPUT, and the copy you inherit was built from whatever that
checkout last had. If it is EMPTY (just .keep), request specs fail too, not only system specs -
stylesheet_link_tag raises 'LoadError: cannot load such file -- sassc', which reads like a
missing gem rather than a missing build. Run dartsass:build before concluding anything from it. Any system spec that reads a computed style then tests stylesheets older
than your branch. That is a false red, and it looks exactly like a real one: an assertion
about white-space or a colour failing on a file you never touched. Run
'bundle exec rails dartsass:build' in your worktree after cloning it and again after any
rebase that brings in a .scss change, before you believe a system-spec failure. It has cost
two runs a review round each already.
IF config/credentials/*.yml.enc SHOWS AS MODIFIED AFTER A DEPLOY, SAY SO OUT LOUD. It happened
once on 2026-08-21 after a mina staging deploy - both production.yml.enc and staging.yml.enc came
back one line different, having been clean immediately before. config/deploy.rb shares only the
.key file and never rewrites the .enc files, so this is not a documented behaviour and nobody has
explained it yet.

DO NOT DISCARD IT. An earlier version of this paragraph said discarding was right when you did
not author it. That was wrong, and it was written before the cause was known: a person was
editing those credentials in another session, in the main checkout, at that moment. A lane ran
'git checkout --' over their work.

Never run 'git checkout --' against config/credentials/ in the main checkout. Say in your result
that the files show as modified and leave them exactly as they are. You cannot tell somebody
else's edit from churn by looking - the diff is ciphertext - so the only safe reading of an
unexpected credentials change is that somebody meant it.

THERE IS NO PRE-COMMIT HOOK. DO NOT USE --no-verify. This paragraph used to say the repo's
hook ran 'bd sync --flush-only' and failed in a worktree, and told you to bypass it. That was
true once and is not true now: site/.git/hooks holds nothing but samples, core.hooksPath is
unset, and no hook anywhere mentions bd. Lanes have been passing --no-verify against a hook
that does not exist, and reporting it as a problem worth flagging - three did today.

Bypassing is the part that matters. --no-verify disables EVERY hook, not the one you had in
mind, so the habit would silently skip a secret scan or a linter the day somebody adds one.
Commit normally. If a hook ever does reject a commit, say what it said in your result and stop
- do not go around it.

Do NOT run 'bd init' inside the worktree - that creates a second database that can flush
unrelated tracker edits into the repo. That part is still true.
Any user-facing string must exist in all seven locales (en de es fr it pt ru), keys built
statically, or spec/i18n_spec.rb fails.

NEVER hand-write a migration filename. Generate it:
  cd ${wtPath} && bin/rails generate migration AddThingToTable field:type
That stamps the real UTC time to the second. Choosing the version by hand produces round
numbers - 20260818140000 and the like - and two agents working in the same hour pick the
same one. That has already happened: two branches both chose 20260818140000, and the second
to merge would have raised ActiveRecord::DuplicateMigrationVersionError on boot for
everybody. There is no textual conflict between two differently-named files, so nothing in
git or GitHub can see it coming - only the version number itself prevents it.

If you rebase and find your migration is no longer the newest, check that its version is
still unique and still sorts after everything it depends on; rename it if not, and set
db/schema.rb to match.`
  }
  if (role === 'node') {
    return `Share dependencies instead of reinstalling:
  ln -s ${repoPath(repo)}/node_modules ${wtPath}/node_modules

${repoCommands(repo)}

A warning that is already on master is not yours to fix as a drive-by - check whether it is
pre-existing before touching it, and leave it if it is.`
  }
  if (role === 'script') {
    return `This repository has a check script rather than a test suite.

${repoCommands(repo)}

Run it before you push.

There is still no test suite and no linter, so the rest of the checks are yours to
make by reading: every path and link you write must resolve, anything you claim about the
product must match what the code actually does, and a file you move must not orphan a
reference elsewhere in the folder. Say in your result what you checked and how.

WORK IN A WORKTREE. NEVER BRANCH INSIDE ${repoPath('docs')} ITSELF. An earlier version of this
said a worktree bought nothing here because the repository is small - which mistook cheapness for
safety. That checkout routinely holds a person's unfinished articles: on 2026-08-29 it carried a
modified topics-from-search.md and five untracked drafts. Branching there puts your commit on top
of their work, and one 'git add -A' commits their drafts into your pull request.

  cd ${repoPath('docs')} && git fetch origin --quiet
  git worktree add --force /tmp/devloop-worktrees/${task.id} -b ${`devloop/${task.id}`} origin/master
  cd /tmp/devloop-worktrees/${task.id}

Everything after that happens in the worktree. Do not cd back, do not check anything out in the
original, and remove the worktree when you hand off. Branch from origin/master rather than the
local master, which may be behind or may not be what is checked out.`
  }

  return `${repoCommands(repo)}

If this repository commits its build output, CI fails when it was not rebuilt from source, so
commit the rebuild. Never publish a package or push a release tag: releasing is a person's job.`
}

// A UI change gets designed before it gets built. The designer decides what it should look
// like; the implementer only builds it. Without this the fix agent invents an appearance,
// and "it passes the tests" says nothing about whether it is right on the screen.
function designPrompt(task) {
  return `Design the user-facing change for one issue, before anybody writes it.

Issue: ${task.id} - ${task.title}
Repo: ${task.repo} (${repoPath(task.repo)})

THE TICKET IS BELOW, IN FULL. You have no Bash tool and cannot fetch it yourself, so this
text is your only access to it - read it before designing anything.

--- ticket ${task.id} ---
${task.ticket || '(NOT AVAILABLE)'}
--- end ticket ---

IF THAT SAYS (NOT AVAILABLE) OR IS EMPTY, STOP. Return a brief whose only content is that the
ticket did not reach you. Do NOT design from the title, and do NOT design from the title while
marking your guesses for somebody to check later. A brief written blind
is worse than no brief: it is specific, it is confident, and it gets built. One went out
specifying a read-only admin section when the ticket required edit and destroy, no destroy at
all when the ticket had recorded exactly when destroy is allowed, and no re-verification
control when the ticket asked for one. It carried "[CHECK AC]" markers on those very points,
so the gap was known at the time of writing and the brief shipped anyway.

WHAT THE ISSUE ALREADY DECIDES IS NOT YOURS TO REDECIDE. Read its description, its design
notes and its acceptance criteria as binding, and design within them. This has gone wrong
already: two briefs for the same issue both specified a new band REPLACING an existing one
when the issue said plainly that both should render, and the implementer had to follow the
tracker over the brief. If you believe what the issue asks for is wrong, say so in one line
at the top of your brief and design what it asks for anyway - the disagreement is a decision
for a person, and a brief that quietly contradicts the ticket produces work that gets thrown
away or, worse, shipped against the ticket.

Read the surrounding code and the existing design system before proposing anything - this
is an established product, not a blank page. For site that means the stylesheets under
app/assets/stylesheets and the Bootstrap 5.3 conventions the views already use; for the
extension it means src/sidebar and its existing panel styles.

House rules that are not negotiable:
- Stylesheets and Stimulus controllers only. No CSS or JavaScript written into a view; a
  css: block outside a turbo frame never reaches the page anyway.
- Reuse an existing component, class or pattern where one fits. A second way of doing
  something that already has a way is a defect, not a design.
- Contrast must meet WCAG AA against the actual background it sits on. State the measured
  ratio for any colour you introduce, and do not claim one you have not calculated.
- Any user-facing string needs a locale key, in all seven locales (en de es fr it pt ru).

Produce a brief the implementer can build from without making appearance decisions:
which elements change, which existing classes and tokens to use, what the states are
(default, hover, focus, disabled, empty, error), what it does at narrow widths, and what
must NOT change. Name files and selectors. If the issue does not actually change anything a
user sees, say so plainly in one line - that is a valid answer and the work will proceed
without a design.

Do not write the implementation, do not edit any file, do not open a PR. Never use 2>&1.`
}

function fixPrompt(task, attempt, feedback, laneIndex, brief) {
  const wtPath = `${WT}/${task.id}`
  const branch = `devloop/${task.id}`
  // Scratch lives OUTSIDE the worktree, one directory per issue.
  //
  // Both halves matter. Outside, because anything written inside the worktree can be picked
  // up by `git add -A` and reviewed as if it were the change - there is already a grep guard
  // in the commit step for exactly that. One directory per issue, because lanes were writing
  // dbg.txt, full.txt and err-before.txt straight into the shared worktrees parent, where two
  // lanes debugging at once overwrite each other's output and neither notices. That is the
  // same failure as two runs sharing a test database, in a place nobody thought to look.
  const scratch = `/tmp/devloop-scratch/${task.id}`
  const again = attempt > 1
  return `${again ? 'REWORK' : 'Fix'} one tracker issue end to end and open a pull request.

Issue: ${task.id} - ${task.title}
Repo: ${task.repo} (${repoPath(task.repo)})
Worktree: ${wtPath}
Branch: ${branch}
Scratch: ${scratch} - every temporary file you write goes in here. Test output, diffs,
  message drafts, before-and-after captures. Never write scratch into the worktree, and
  never into ${WT} itself, which is shared with every other lane.
${again ? `\nThis is attempt ${attempt} of ${MAX_ATTEMPTS}. An automated adversarial review REJECTED the previous attempt:\n---\n${feedback}\n---\nThe worktree and branch already exist with your earlier work on them. Address every blocking point, amend or add commits, push to the same branch, and keep the same PR. Do not open a second PR.\n` : ''}
THE TICKET IS BELOW IN FULL - triage already read it and passed the text on, so you do not
need to run bd to see it. Read it before touching anything.

--- ticket ${task.id} ---
${task.ticket || '(not carried - run: bd show ' + task.id + ' from ' + ROOT + ')'}
--- end ticket ---

Run bd yourself only if you need something this does not contain, such as the dependency
tree or another issue it names.

CHECK THE TICKET IS STILL OPEN BEFORE YOUR FIRST EDIT. One command, and it costs nothing:

  cd ${ROOT} && bd show ${task.id} | head -1

If it says CLOSED, STOP and hand back with outcome no_change_needed, naming what closed it.
Do not start, and do not "finish it anyway" because the work looks unfinished from here.

WHY THIS IS NOT PARANOIA. The owner triages and works in his own sessions, in parallel with
this pipeline, and a ticket can be answered between triage reading it and you reaching this
line. On 2026-09-07 a lane was dispatched a blog article, the owner published his own version
and closed the ticket two minutes into the run, and the lane wrote the entire article again
before fetching and finding master had moved. Everything it produced was thrown away.

The same check is worth repeating as a habit before any long stretch of writing - fetching
origin/master and re-reading the ticket costs seconds and can save an hour of work that
lands nowhere.
${brief ? `\nA designer has already decided how this should look. Build exactly this; do not
re-decide appearance, and if you think it is wrong, stop and ask rather than improvising:\n---\n${brief}\n---\n` : ''}

${again ? '' : `Set up the worktree. THE BRANCH MAY ALREADY EXIST, so check before creating it:
  cd ${repoPath(task.repo)}
  git fetch origin --quiet
  if git ls-remote --exit-code --heads origin ${branch} >/dev/null; then
    git worktree add ${wtPath} -B ${branch} origin/${branch}
  else
    git worktree add ${wtPath} -b ${branch} origin/master
  fi
  mkdir -p ${scratch}
Mark it claimed, from ${ROOT}:
  bd update ${task.id} -s in_progress

BRANCH FROM origin/master, NEVER FROM ANOTHER LANE'S BRANCH, and open the pull request against
master. If the work you need sits in a pull request that has not landed yet, that is a
dependency - say so and stop, or build the part that does not need it. Do not stack on it.

A stacked pull request breaks this pipeline in two ways at once. The CI workflow only runs on
pull_request when the base is master, so a stacked one has an EMPTY rollup forever and no amount
of waiting produces a check - and a workflow_dispatch run you trigger yourself is not the same
thing and must never be read as one. Worse, the train squashes every labelled branch onto one
release branch, and a branch stacked on another carries the other's commits too, so the same
change gets applied twice.

That happened on 2026-08-30: site#825 was opened against devloop/app-fe2n.2, labelled on the
strength of a dispatch run, and had to have the label pulled by hand before a train reached it.

IF THE BRANCH ALREADY EXISTED, you are CONTINUING somebody's work, not starting it. This
happens whenever a branch outlives its worktree - a run that pushed and then died, or an issue
whose first pass shipped part of the job and left the rest. Before you change one line:

  git log origin/master..HEAD
  git diff origin/master...HEAD --stat

and read the issue's notes for what that work was and what remains. Then rebase onto
origin/master before adding to it, because the branch is probably behind.

DO NOT rebuild what is there from scratch, and do not reset the branch to master. That work is
already reviewed, sometimes already pushed, and re-deriving it burns a full run to arrive back
where the branch already was. This exact gap held app-5ek6.5 for two days: the branch carried
the whole ad-creative factory at 77264c7 and every dispatch would have branched fresh from
master straight over the top of it.
`}
${checksFor(task.repo, wtPath, laneIndex)}

IF THIS CHANGES ANYTHING A USER SEES and you were given no design brief above, stop
immediately and return status 'needs_design' with what the change would touch. Do not
invent an appearance. A designer will be run and you will be called again with the brief.

IF YOU WERE GIVEN A BRIEF, you must also produce visual evidence, because the reviewer is
required to look at it before approving.

The evidence is scaffolding, and NONE OF IT MAY REACH THE COMMIT. A capture path that ends
up in a permanent spec makes every future run of that suite, on every machine, write into a
scratch directory that only exists here.

- site: write a THROWAWAY spec at ${WT}/${task.id}/spec/system/autofix_capture_spec.rb that
  drives the screen and calls page.save_screenshot("${WT}/shots/${task.id}-after.png").
  Capture origin/master the same way first, as "...-before.png", where the screen exists.
  DELETE that spec file before you commit. If the fix also warrants a permanent system spec,
  that is a different file and it must contain no save_screenshot and no ${WT} path.
- extension: render the panel headless into the same directory, from a script you delete.

Create ${WT}/shots first. Return the absolute paths in 'screenshots'.

Before committing, prove none of it leaked:
  cd ${wtPath} && git diff --cached --name-only
  cd ${wtPath} && git diff --cached | grep -n "devloop-worktrees\|save_screenshot" || true
If either turns up anything, remove it and stage again. Untracked leftovers matter too -
check 'git status --porcelain' is limited to what you meant to commit.

If you genuinely cannot capture the screen, say why in the summary - the reviewer will then
have to escalate rather than approve.

STOP AND ASK instead of guessing, if any of these is true:
- The issue offers a choice ("either X or Y", "decide whether") and the answer changes what
  ships.
- The fix would MOVE MONEY, change what a customer is charged, or decide whether a payment is
  honoured; or it would choose, mint or rotate a secret; or it is a destructive data
  migration.
  IDENTITY WORK IS NO LONGER EXCLUDED. Decided 2026-08-21 by Vladimir, overruling a
  recommendation to build-and-open-a-PR-without-merging. Authentication and authorization
  changes - PKCE, token audience binding, scope sets, client registration, session and token
  lifetime, reset and confirmation flows, roles and policies - are ordinary work now and may
  be landed unattended like anything else. Choosing, minting or rotating a SECRET is still
  excluded, and so is deciding whether a payment is honoured.
  The test is what the change DECIDES, not which directory it lives in - the same test the
  eligibility gate below applies. Reading a secret that is already configured is not the same
  as choosing what it is: verifying a webhook signature against every secret the credentials
  hold, reading a second key as well as the first, deduplicating them or correcting the key
  shape changes only whether a delivery somebody else signed is recognised. It mints nothing,
  rotates nothing and charges nobody, and it is ordinary work with ordinary tests. Refusing it
  once on the word "credentials" left live webhooks answering 400 for three days while the fix
  waited behind it. If you cannot tell whether a change alters what somebody is charged, stop
  and ask.
- It cannot be reproduced or verified from here - it needs a device, an account, an
  installed PWA, or a production observation.
- The right fix is materially larger than the issue implies, or would change behaviour
  people depend on.
- You cannot get tests green without weakening an assertion.
To stop: write the question onto the issue so a person can answer it without re-reading the
code, from ${ROOT}:
  bd label add ${task.id} <needs-decision if a choice only a person can make, needs-access if it needs a deploy/dashboard/device they have and you do not>
  bd update ${task.id} -s open --append-notes "<what you found, the exact decision needed, and the options with your recommendation>"
Then return status 'needs_feedback' with that question. Leave the worktree and any branch in
place. This is a good outcome, not a failure - a wrong guess shipped unattended is worse.

Otherwise:
1. Confirm the defect in the code before changing anything. If it is not there, is already
   fixed, or the ticket's premise is wrong, that is a real result and often a better one
   than a change. Return 'no_change_needed', and CLOSE the issue yourself, from ${ROOT}:
     bd close ${task.id} --reason "<what you measured, and why no change was needed>"
   Closing matters: an issue left open comes straight back to the front of the queue and
   another agent repeats the investigation. Put the evidence in the close reason, not just
   a verdict - whoever reads it should not have to re-derive it. If part of the ticket does
   hold, say which part and leave that as its own issue rather than closing it away.
   Never invent a change to justify a ticket.
2. Make the smallest change that fixes it. Match the surrounding style and naming.

   WRITE NO COMMENTS. The owner's instruction, 2026-08-28, in their own words: "I don't need
   comments."

   Not "fewer", not "only where they earn their place" - none. Do not write a comment above a
   method, a constant, a class, a migration, a spec or a config line. Do not explain what a
   line does, why it is there, or what would break without it.

   THE RULE THIS REPLACES IS WHAT CAUSED THE PROBLEM. It said "match the surrounding comment
   density", which is a feedback loop with no anchor: each lane imitated the last one, so the
   ratio ratcheted. Measured on this repository, comment lines per line of added code - 0.10
   in early August when a person was writing it, then 0.28, 0.37, and 0.39 by 2026-08-28.
   Four times the baseline, entirely from imitation. Do not reintroduce a relative rule.

   WHERE THE 'WHY' GOES INSTEAD, because it still matters and must not simply be lost:

     the commit message   for why this change is the way it is. git blame takes a reader from
                          any line to it, which is a better path than a comment that drifts
                          out of date silently while the code moves.
     the PR body          for what the reader of a diff needs.
     the tracker issue    for a decision, a rejected alternative, or a past failure. That is
                          what --append-notes is for and it is already the habit here.

   So a past incident, a constraint that is invisible in the code, a reason an obvious
   approach was rejected - all of that still gets written down. It goes in the commit message
   and the ticket, not into the file.

   EXISTING COMMENTS ARE NOT YOURS TO SWEEP. Leave them where they are unless your change
   makes one wrong, in which case correct or delete that one. Do not open a diff to strip
   comments from code you are not otherwise touching - a large comment-only diff is a large
   diff to review for no behavioural gain.
3. Add a test that fails before the fix and passes after. Say what it would catch. If it
   genuinely cannot be tested, say why rather than writing an assertion that proves nothing.
4. Run the checks above until green - but iterate on the targeted file first and keep the
   full suite for the end. On site the full suite is about two and a half minutes and a fix
   round that runs it after every edit spends most of its life waiting. Narrow while you
   work ('rspec path/to/file_spec.rb:42'), then run everything once before you commit, and
   again only if you changed something after that.
5. ${task.repo === 'docs'
   ? `Run 'ruby script/check.rb', then commit, push, and open a PR with 'gh pr create'
   explaining what was wrong, why this fix, and what you checked by reading. Reference
   ${task.id}. Do NOT merge it. This repository gained a remote and CI on 2026-08-19; the
   instruction that it had neither outlived the fact by a day and would have had you commit
   straight onto a real default branch.`
   : `Commit, push, and open a PR with 'gh pr create' explaining what was wrong, why this fix,
   and what the test covers. Reference ${task.id}. Do NOT merge it.`}

${LAW}

Return the structured result, with the real final counts line from the test run in
testOutput - the actual line, not a paraphrase.`
}

function reviewPrompt(task, work, attempt) {
  return `Review a pushed fix. Try to REFUTE it. You are the only thing between this change
and an unattended merge, so a wrong approval ships.

Issue: ${task.id} - ${task.title}
Repo: ${task.repo}
Worktree: ${work.worktree || `${WT}/${task.id}`}
PR: ${work.prUrl || work.prNumber}
Author's claim: ${work.summary}
Test they added: ${work.testsAdded || 'none reported'}
Round ${attempt} of ${MAX_ATTEMPTS}.

Read the issue with 'bd show ${task.id}' from ${ROOT}, then read the actual diff:
  cd ${work.worktree || `${WT}/${task.id}`} && rtk git diff origin/master...HEAD

rtk is a filter in front of git that drops diff context lines while keeping every changed line.
Measured on this repository: 40079 bytes down to 24211, a 40% cut, with nothing removed that a
reviewer needs. It falls back to plain git when it has no filter for a command, so it is safe
to leave in place. Do NOT use it for anything else - rtk grep shows a fraction of its matches
and reports the true count beside them, rtk test hides the pass/fail summary on this suite, and
rtk log drops the failing spec locator out of a CI log.

${(work.touchesUi || (work.screenshots && work.screenshots.length)) ? `THIS IS A UI CHANGE. You may not approve it on the diff alone. Look at it:
- Read every path in ${JSON.stringify(work.screenshots || [])} with the Read tool. It
  renders images; actually look at what came back.
- Judge it as a person seeing the screen: is the thing the issue complained about gone, is
  spacing and alignment consistent with what is around it, does it survive a narrow width,
  is any text unreadable against its background.
- Check the change follows the design brief it was built from rather than approximating it.
If there are no screenshots, or they do not show the affected screen, set approved:false and
say the change could not be visually confirmed. Set visuallyConfirmed honestly - false if
you did not actually view an image.
` : ''}Answer sceptically:
- Does this fix the defect as described, or something adjacent, leaving the reported symptom
  reachable?
- Would the test fail if the fix were reverted? Verify it: revert the source change in the
  worktree, run that test, restore it. Leave the worktree byte-clean and say you did.
- Did unrelated changes ride along?
- Did any scaffolding reach the commit? Run
  'git diff origin/master...HEAD | grep -n "devloop-worktrees\|save_screenshot"'. A scratch
  path or a capture call inside a committed file is an automatic rejection: it makes every
  future run of that suite write into a directory that exists on one machine.
- What breaks that the suite cannot see? Other callers of the changed code, a state the new
  condition handles differently, a failure mode that becomes silent instead of loud.
- Is anything here a new decision that a person should have made?

Approve only if you would merge it yourself, unreviewed, into a product with paying users.
Set approved:false if you are unsure. When rejecting, put concrete, actionable items in
'blocking' - the next attempt gets only what you write there.

Do not modify the branch, do not push, do not merge, do not deploy. Never use 2>&1.`
}

// A lane used to merge and deploy its own work. It does not any more: it gets the PR green,
// labels it 'lane-verified', and stops. One serial lander (land.js) rebases, merges and
// deploys, one PR at a time.
//
// This is why. Eight lanes each rebased onto master, pushed, waited for CI, and found master
// had moved again because another lane merged during the wait - so they rebased and waited
// again. The merge lock serialised the merge itself but not the rebase-and-wait in front of
// it, so the cost still grew with the number of lanes. Landing serially, each branch rebases
// at most once and nobody waits behind a lock for a turn they may not get.
//
// GitHub labels, not tracker status, decide what is landable. Tracker status has been wrong
// often enough that the owner asked for the two to be untangled - a label is set by the lane
// that did the work and read by the lander, and nothing else writes it.
function handoffPrompt(task, work) {
  const wtPath = work.worktree || `${WT}/${task.id}`
  const repo = repoPath(task.repo)
  // A PULL REQUEST NUMBER IS MEANINGLESS WITHOUT ITS REPOSITORY, and `cd`-ing first is not
  // enough. `gh pr view 20` means "number 20 in whatever repo this directory points at", so a
  // run that was routed to the wrong checkout gets a real, plausible answer instead of an
  // error. In this workspace numbers 1-10 exist in ALL THREE repositories and 1-20 in two, so
  // a bare number NEVER 404s - there is no failing case to notice.
  //
  // That nearly labelled an unrelated merged pull request as verified, which the lander merges
  // on sight. It was caught only because the two titles were absurdly different; two tickets
  // of the same kind would not have that tell, and this queue produces those constantly.
  const slug = (REPOS[task.repo] || {}).slug
  return `This change passed an automated adversarial review by another agent. NO HUMAN HAS
REVIEWED IT. Do not describe it as human-approved to anyone or in anything you write.

You are NOT merging this and you are NOT deploying it. Your job is to leave the pull request
in a state the lander can pick up without asking anyone anything: green, compliant, labelled.
Do not merge, do not rebase, do not deploy, do not close the issue. Those belong to the
lander now, and doing them here is what this change exists to stop.

Issue: ${task.id} - ${task.title}
Repo: ${task.repo}
PR: ${work.prUrl || work.prNumber}

1. WAIT FOR THE PR'S OWN CHECKS AND CONFIRM THEY ARE GREEN. Poll, do not assume:
     cd ${repo} && gh pr view ${work.prNumber} --repo ${slug} --json statusCheckRollup,headRefOid

   Every check must have conclusion SUCCESS, AND THERE MUST BE AT LEAST ONE. For the first
   minute or so after a push the rollup is an EMPTY ARRAY - GitHub has not registered the run
   yet. "All of them are green" is TRUE of no checks at all, in jq and in English, so a
   waiting loop built on all(...) exits instantly having seen nothing. Treat an empty rollup
   as "not started, keep waiting", never as a pass.

   DO NOT FALL BACK TO THE LEGACY COMBINED-STATUS ENDPOINT while you wait. The endpoint
   repos/<owner>/<repo>/commits/<sha>/status answers state "pending" with total_count 0 on
   these repositories - not because something is unfinished, but because they publish check RUNS
   and no commit statuses at all, and that endpoint reports only the latter. It says "pending"
   forever, for every commit, including green ones. A loop reading .state from it never exits.
   Stay on statusCheckRollup, or use repos/<owner>/<repo>/commits/<sha>/check-runs.

   Confirm the rollup describes the commit you actually pushed, and COMPARE THE FULL FORTY
   CHARACTERS. The API returns the full sha and 'git rev-parse --short' returns seven, so a
   filter written as select(.headSha == "abc1234") matches nothing, forever - and "no run
   found" is indistinguishable from "not registered yet", so the loop spins while the run has
   been sitting there green the whole time. Use 'git rev-parse HEAD', or startswith().

   If the PR is RED, that is yours to fix and not the lander's: return status 'blocked' with
   the failing examples and their messages in 'notes', in enough detail to act on without
   re-running anything. Do not label a red PR.

   You do NOT need master to be green, and you do NOT need your branch to be current with
   master. The lander checks both, rebases, and waits for CI again on the rebased head. That
   is the whole point of it being serial - it is the only thing merging, so master cannot
   move underneath it.

2. CHECK COMPLIANCE BEFORE YOU LABEL. Read the PR body back from GitHub and the commit
   messages back from git - not what you meant to write, what is actually there:
     cd ${repo} && gh pr view ${work.prNumber} --repo ${slug} --json body
     cd ${repo} && git log origin/master..origin/devloop/${task.id} --format=%B
   If anything mentions AI, assistants, automated authorship or tooling, FIX IT NOW rather
   than labelling it: edit the body with 'gh pr edit ${work.prNumber} --repo ${slug} --body-file <file>', and
   if a commit message is the problem say so in 'notes' and return 'blocked' - rewriting
   history under a pushed branch is not something to do unattended.

   ONE EXCEPTION, settled by the owner on 2026-08-23: THE NAME OF A THIRD-PARTY PRODUCT THIS
   CHANGE INTEGRATES WITH IS SUBJECT MATTER, NOT AN AUTHORSHIP CLAIM. This product ships an
   MCP server, and the clients that connect to it are called Claude Code, Codex and Gemini CLI.
   A page documenting how to connect them has to name them, and so does the pull request
   explaining that page: 'claude mcp add --transport http one workspace <url>' is a command a
   customer types, not a confession about who wrote the code.

   The rule being enforced is that NOBODY MAY BE TOLD THIS CODE WAS WRITTEN WITH HELP. It is
   not a ban on a string. So ask what the sentence is doing:
     - names a client, an API, a vendor's documentation, or a command a user runs -> KEEP IT
     - says or implies that an agent, assistant or tool wrote, reviewed or generated this
       change, in any wording, including a Co-Authored-By trailer -> REMOVE IT
   When it is genuinely ambiguous, keep the product name and say in 'notes' what you kept and
   why, so the next reader is not left re-deciding it.

   YOUR SCOPE IS YOUR OWN DIFF. Text already on master is not yours to police, however it reads.
   Editing it invalidates the green run for a line your change never introduced, and the next
   lane will meet the same line and do it again.

   This comes up in the docs repository, and the answer is settled so nobody re-derives it:
   .github/workflows/ci.yml opens by saying the repository is worked on by automation that merges
   only on a green check, and docs/devloop-porting.md describes lanes and the lane-verified label
   throughout. Both are FINE and both stay. They describe a development pipeline the way a
   repository describes its own CI - the project's root CLAUDE.md documents the same pipeline
   openly - and neither says a change was written or reviewed with help, which is the only thing
   the rule forbids. Do not edit them, and do not report them as a finding.

3. LABEL THE PR. This is the handoff, and it is the only signal the lander reads.

   STEPS 1 TO 5 OF THIS HANDOFF ARE ONE COMMAND. Prefer it:

     bash ${SKILL_DIR}/lane-handoff.sh --repo-path ${repo} --slug <owner/name> \
       --pr ${work.prNumber} --branch <your branch> --issue ${task.id} \
       --note-file <a file holding your tracker note> --worktree ${wtPath}

   --worktree, --lane-lock and --note-file are ALL OPTIONAL. Leave out any you do not have and
   the script skips that step. It needs only --repo-path, --slug, --pr and --branch. A lane read
   the older wording here as though --lane-lock were required, could not supply one, and did the
   whole handoff by hand instead - which works, but skips the compliance refusal that is the
   reason this script exists.

   It reads the title and body back from GitHub and the commit messages back from git, runs the
   compliance grep over both, checks the rollup is non-empty and describes the head that is
   actually on the branch, labels, reads the label back, removes YOUR worktree, appends your
   note with --append-notes and reads it back, and drops your lane lock last.

   Exit codes: 0 handed off, 2 non-compliant (NOTHING was labelled - it prints the offending
   lines, you judge them, you fix, you re-run), 4 not in a state to label, 6 bad arguments.

   ITS REFUSAL TO LABEL IS THE POINT. A label is an assertion that the PR is ready. Labelling
   first and fixing after is how the wrong text reaches master. If it reports hits, read them:
   a vendor or product name that is the SUBJECT of the change is fine, and the script cannot
   tell the difference - that judgement is yours, and 'sends automatically', 'the model' and
   'regenerated' have all been correctly kept before.

   Use --check-only to see the verdict without changing anything.

   If the script is missing, do it by hand with the steps below, which are the same sequence:
     cd ${repo} && gh pr edit ${work.prNumber} --repo ${slug} --add-label lane-verified

   If that fails because the label does not exist in this repository, create it once and
   retry:
     cd ${repo} && gh label create lane-verified --description "Reviewed and green: ready for the serial lander" --color 0E8A16

   Then READ IT BACK. gh often prints nothing on success, and silence looks exactly like
   failure:
     cd ${repo} && gh pr view ${work.prNumber} --repo ${slug} --json labels
   The label must be in that list. If it is not, the lander will never see this PR and the
   work is invisible - say so in 'notes' and return 'blocked'.

   THE LABEL IS ONE-WAY. Once it is on, this pull request belongs to the lander and you must
   NEVER take it off again - not to hold the change for one more thought, not to add a test you
   wish you had written, not for any reason. The lander may already be mid-attempt on it, and it
   holds a global merge lock while it works: removing the label underneath it strands the lock
   and blocks every other pull request in the queue behind yours.

   That is not hypothetical. On 2026-08-24 a lane pulled the label back forty minutes into an
   attempt to add a missing spec pin, and the entire landing queue sat behind the held lock until
   a person put the label back by hand. The pin was worth having; it was not worth an hour of
   everything else.

   If you find something after handing off: say it in 'notes', let the change land, and fix
   forward in a follow-up. A green pull request that is missing a test is a smaller problem than
   a queue that is not moving.

4. REMOVE YOUR WORKTREE. It holds the branch checked out, and the lander's --delete-branch
   fails on that every single time, leaving both branches behind and a non-zero exit that
   looks like the merge failed:
     cd ${repo} && git worktree remove ${wtPath} --force

5. Record where it stands, from ${ROOT}:
     bd update ${task.id} --append-notes "<what the change does, the PR url, and that it is green and labelled lane-verified awaiting the lander>"

   LEAVE THE ISSUE OPEN AND in_progress. Do NOT close it - it is not deployed yet, and the
   lander closes it when it is. Use --append-notes, never --notes: --notes overwrites the
   whole field and has already destroyed a decision somebody recorded.

${LAW}

Return status 'verified' once the PR is green and the label reads back. Put the PR number in
'prNumber' so the lander can be pointed straight at it.`
}

function giveUpPrompt(task, feedback) {
  return `Three review rounds did not produce something mergeable for ${task.id}
(${task.title}). Hand it to a person cleanly.

The last reviewer's blocking notes:
---
${feedback}
---

CHECK BEFORE YOU LABEL: read the issue's notes first. If they record the OWNER clearing a
parking label - phrases like "removing it again", "label re-applied after being cleared",
"unparked" - then DO NOT add the label back. Say in your result that you would have parked it
and why, and let the supervisor take it up with a person. A label the owner removed is their
decision; re-applying it automatically is the pipeline overruling them, and it has already
happened twice on app-i6yt and app-233a. Writing the QUESTION into the notes is always allowed and
is what they asked for - a bare label with no question cannot be answered.

From ${ROOT}:
1. bd label add ${task.id} <needs-decision if a choice only a person can make, needs-access if it needs a deploy/dashboard/device they have and you do not>
2. bd update ${task.id} -s open --append-notes "<what was attempted across the three rounds, what
   the reviewer would not accept and why, what you believe the real decision or difficulty
   is, and where the branch and PR are>"
   Write it so somebody can pick this up without reading three transcripts.
3. Leave the branch and the PR open. Do not merge, do not close, do not delete the worktree.
4. Run bd show ${task.id} once more and return its first six lines VERBATIM as 'verification'.

Step 4 exists because a handover once reported both changes made and verified when the issue
carried no label and was still in_progress. The queue read it as ready and offered it straight
back out. Report what you actually see, including "it did not work" - a failed park that says so
costs one line, and a failed park that claims success costs another full run.

Never use 2>&1. Do not modify any code.`
}


async function design(task) {
  const brief = await agent(designPrompt(task), {
    label: `design:${task.id}`, phase: 'Design', agentType: 'page-designer'
  })
  log(`${task.id}: designed`)
  return brief
}

phase('Triage')

const triage = await agent(`Decide whether one tracker issue can be done without a person, and where it lives.

Issue: ${ID}. Read it from ${ROOT}:
  export BEADS_DIR=${ROOT}/.beads
  bd show ${ID}

RETURN THE WHOLE TICKET BODY AS 'ticket', EVEN IF YOU BOUNCE THE ISSUE. The designer that may
run after you has no Bash tool and cannot fetch it - what you return is handed to it directly
in its prompt, and it is the only copy it gets. This used to travel through a file, and the
file was not there: the designer designed from the title alone, and three review rounds spent
two and a half hours failing to converge on a brief that never contained the acceptance
criteria. Copy the description, the design notes and the acceptance criteria as printed.

Do NOT judge the issue's status. The supervisor claims an issue as in_progress at the
moment it dispatches this run, so in_progress is the expected state here and means the run
holds it - not that somebody else does. Status is already filtered before you are called.

Read dependencies in the right direction before calling anything blocked: an arrow pointing
left ("<- app-xxxx") is an issue THIS one blocks, which is no impediment. Only an open issue
that this one depends on is a blocker.

Return eligible:false, with a reason, if any of these holds:
- it is already labelled needs-decision, needs-access, blocked-tooling or watch, is an epic, or genuinely depends on an open issue

  VERIFY A RECORDED BLOCKER BEFORE HONOURING IT. A note saying "blocked on X" or "do not
  dispatch until X closes" records what was true the day it was written. Run 'bd show X' and
  look at the status. If the note names a pull request, check whether it merged. If it names a
  file, a locale key or a column that supposedly does not exist yet, look on origin/master.

  Four tickets on 2026-08-28 carried a blocker that had already cleared, and every one cost a
  full lane dispatch to discover - roughly 100k tokens each. On app-grlg the note said it was
  blocked on app-ojcs.1; app-ojcs.1 was closed, its PR had merged the previous evening, and the
  locale key the note called missing was on master. The retry shipped it in one attempt.

  The same applies in reverse to prose about labels. THE LABEL IS WHAT PARKS AN ISSUE, not a
  sentence in the notes describing how parking works or what somebody should have done. Read
  the labels field. If it is empty, the issue is not parked, whatever the prose around it says.
- it offers a choice where the answer changes what ships

  BUT LOOK FOR AN ANSWER THAT ALREADY EXISTS BEFORE YOU CALL IT A CHOICE. A question can be
  open on THIS ticket and settled everywhere else, and the project's answers are not gathered
  in one place - they are on sibling issues, in code comments, and in stylesheets. Two lanes
  on 2026-08-29 bounced a decision that was already recorded, roughly 90k tokens each:

    app-m0cc asked whether to raise a Capybara timeout or emit a readiness signal. app-nnpg
    already refuses the timeout by name - "(b) raising Capybara.default_max_wait_time is
    refused ... (c) repairing specs to assert on readiness rather than presence is the route".

    app-41ci asked which Linear logo variant may sit on a dark background. The card's own view
    comment records that the asset is the light-background variant taken unmodified, and
    dashboard.scss already states the rule - "tinting, dimming or resizing somebody's brand
    asset is the thing their terms forbid".

  So before returning eligible:false for a decision, spend two or three calls looking:
  'bd search <the subject>' for a sibling that settled it, and grep the code and stylesheets
  around the thing you are changing for a comment that states the rule. If you find one, quote
  it, follow it, and proceed - applying a decision the project has already made is not making
  one. Escalate only what is genuinely unanswered, and say where you looked.

  LOOK IN THE TICKET FIRST OF ALL. A ticket that offers options and then names one is not asking
  you to choose - its author already did the thinking and wrote the answer down. Follow the
  recommendation, say in the pull request that you followed it, and get on with it. Two lanes
  bounced on this in one afternoon and the supervisor decided both in under a minute each,
  by reading the same paragraph the lane had already read:

    app-5z9n listed two options and said "Recommendation: 2, unless the toggle is actually
    wanted", with the reasoning - the drawings are already baked into the screenshot, so the
    separate layer is storage nobody reads. Bounced as "a product call".

    app-8wbi offered "write the missing article, or repoint the link". The link was decorative
    in a sentence that reads correctly without it, and no article on the site was a fair
    target. Bounced as "editorial judgment".

  WHAT STILL DESERVES A BOUNCE, so this is not read as "never escalate":
    - money, law, access, or brand - a price, a licence, a credential, a published name
    - anything IRREVERSIBLE once shipped: a URL somebody may link, a published filename, a
      migration that drops data
    - a real blocker: the thing you need does not exist yet, or an account you do not have
    - a genuinely open question with no recommendation anywhere and no way to infer one

  The test is not "is this a choice" - almost everything is. It is "would a careful colleague
  reading this ticket know what to do". If the ticket recommends, they would. Every bounce costs
  a full lane dispatch, so bouncing a decision the ticket already made is the most expensive way
  to read a paragraph.

- THE APPROACH IT PRESCRIBES CANNOT WORK, even though the goal is clear. You are reading the
  ticket anyway, so say so now rather than letting three review rounds discover it. The
  tells, each of which has cost roughly 600k-900k tokens and shipped nothing:
    * it asks for a rule to be expressed as a pattern over something that has real structure -
      matching HTML or CSS with regular expressions, deciding a selector's meaning by string
      shape. Every fix closes one hole and opens another. (app-1jxg.9.3.1, 621k)
    * a selector or heuristic has to tell apart two things that are genuinely identical to it -
      a two-word label from a sentence, a deliberate value from an accidental one. (app-fave.1,
      909k: a CSS rule could not distinguish a code-block label from a paragraph.)
    * the ticket has already produced defects in the same area more than once, and the notes
      read as a sequence of corrections rather than a plan. (app-dcb8, 794k)
  When you see one, return eligible:false and NAME THE ALTERNATIVE if you can see it - parse
  instead of match, key off something the author declares instead of inferring it. A person
  can accept that in a sentence; three rounds cannot arrive at it.
- it moves money, changes what a customer is charged, or touches payment credentials:
  checkout, subscriptions, prices a customer sees, refunds, webhooks that settle payment,
  API keys. Never unattended.
  Billing-adjacent code that does none of those is ordinary work. Correcting the currency
  and interval on a catalogue object that nothing reads at checkout does not move a penny,
  and refusing it left a bug writing wrong objects into the live account on every admin
  action - which is worse than the fix. The test is what the change does, not which
  directory it lives in. If you cannot tell whether a change alters what somebody is
  charged, stop and ask.
  Reading a secret that is already configured is not the same as choosing what it is.
  Verifying a webhook signature against every secret the credentials hold, reading from a
  second key as well as the first, deduplicating them or correcting the key shape changes
  only whether a delivery somebody else signed is recognised - it mints nothing, rotates
  nothing and charges nobody. That is ordinary work with ordinary tests. Refusing it once
  left live webhooks answering 400 for three days while the fix waited behind the word
  "credentials". Choosing, minting or rotating a secret is still a person's, and so is
  anything deciding whether a payment is honoured.
- (WITHDRAWN 2026-08-21) identity work used to be excluded here - password handling, session
  and token lifetime, two-factor, OAuth, confirmation and reset flows, roles, policies. It is
  not any more. Vladimir relaxed the rule after four OAuth children sat unstartable behind it;
  the recommendation on the table was to build and open a PR without merging, and he chose to
  relax it outright. Treat authentication and authorization as ordinary work.
  WHAT DOES NOT CHANGE, and it is the sharp edge on this kind of work: a check that is present
  but not actually enforced looks identical to a working one from the outside. So for anything
  touching how a credential is proved, the tests must include the REFUSAL, not only the happy
  path - a wrong verifier rejected, a missing one rejected, an audience that does not match
  rejected. A green suite that only ever proves the accept path is the failure mode this rule
  used to guard against, and it is now the reviewer's job rather than the gate's.
  Choosing, minting or rotating a secret is still excluded.
- it is a destructive data migration

Editing the AUTH SCREENS THEMSELVES is fine, and so is threading an ordinary field through
them. A checkbox on the Devise sign-up form, wording on the password reset page, a layout
fix on the login screen, a marketing opt-in carried through the registration command - none
of that decides who gets in, and refusing it was treating the folder a file sits in as if it
were the risk. The test is what the change decides, not where it lives: if it alters who is
admitted, what they may do, or what secret is minted or kept, stop. If it changes what the
page looks like or carries a field that has nothing to do with access, carry on.
- it cannot be verified from a terminal on this machine: it needs a device, an installed
  PWA, a store submission, a production observation, or somebody's account
- it needs an npm publish, a Chrome Web Store submission, or a production deploy
- you cannot tell which repo it belongs to

SPLIT INSTEAD OF ASKING, when the only thing wrong is that the issue bundles work that
belongs in separate runs - it spans repos, or it holds several independent fixes, or part of
it is verifiable here and part is not. Deciding an issue is two issues is scoping, not a
product decision, so it does not need a person. Set eligible:false, splittable:true, and a
'splitPlan' with one entry per child.

Rules for a split, because a bad one is worse than asking:
- Every child must be traceable to text already in the parent. Splitting is not the moment
  to invent scope, drop a requirement, or decide which of several proposed fixes is right -
  if the parent proposes two fixes and leans towards both, make both children.
- Each child must be independently shippable: one repo, its own tests, valuable on its own
  even if its siblings never happen.
- If one child needs a table, a model, a route or a payload shape that another child creates,
  SAY SO AS A DEPENDENCY, not as a sentence: 'bd dep add <later> <earlier>'. The queue can
  check an edge and cannot read prose, so an ordering recorded only in the description gets
  both children dispatched at once, and they invent the same model twice and write two
  migrations for the same table. This has happened twice in one night - app-f13a.4 against
  app-f13a.3, and app-5c19 against app-zd1d - and in both cases the parent said plainly which
  came first. Prefer an edge to a parking label wherever the reason is ordering rather
  than judgement: an edge states a fact, survives being handed around, and releases itself
  when the blocker closes.
- A part that still needs a person - a decision that changes what ships, a repair that needs
  production or a device - is still a child, with autonomous:false and the reason. It gets
  handed over rather than attempted.
- If splitting would leave a child that is still ambiguous, do not split. Ask instead.
- Do NOT split merely because an issue is large. Size is not a reason; independence is.

Otherwise eligible:true. Set 'repo' from the paths and subject matter: site (Rails app),
extension (Chrome extension), integration (npm library).

Set 'ui' true only when somebody has to DECIDE HOW SOMETHING LOOKS OR READS: new or changed
layout, styling, components, states, or on-screen wording. Those go through a designer.

Set it false when the screen changes only because the bug stops happening. A failure state
that no longer appears, a value that is now correct, an error that no longer renders - there
is nothing to design there, and running a designer costs a few minutes to be told so. The
test: if a designer would answer "nothing to design", it is false.

When it is genuinely borderline, prefer true - an invented appearance is more expensive to
undo than a wasted design step.

Report 'title' and 'priority' as the tracker has them. Do not modify anything. Never use 2>&1.`,
  { label: `triage:${ID}`, phase: 'Triage', schema: TRIAGE, model: 'sonnet', effort: 'low' })

if (!triage) return { id: ID, outcome: 'agent_error', at: 'triage' }

if (!triage.eligible && triage.splittable && (triage.splitPlan || []).length > 1) {
  phase('Split')
  const plan = triage.splitPlan
  const split = await agent(`Split issue ${ID} into the children below. This is bookkeeping,
not design: create exactly these, change no code, and do not enlarge or reinterpret them.

Parent: ${ID} - ${triage.title} (P${triage.priority})
Read it first, from ${ROOT}: bd show ${ID}

The titles below may repeat the repo prefix that the list already carries - "[site] [site] ..."
if the list groups by repo. Strip the duplicate: one prefix, matching the parent's own title.
Create the title as it should read, not as it was pasted.

Children to create, in order:
${plan.map((c, i) => `${i + 1}. [${c.repo}] ${c.title}
   scope: ${c.scope}
   ${c.autonomous ? 'can be done unattended' : `needs a person: ${c.whyNotAutonomous}`}`).join('\n')}

For each, from ${ROOT}:
  bd create "<title>" -t <type> -p ${triage.priority} --parent ${ID} -d "<the scope, written so
  somebody can act on it without reading the parent: what is wrong, where in the code, and
  what done looks like. Carry across the concrete detail the parent already established -
  file and line references, reproductions, ids - rather than pointing at the parent for it.>"
  --acceptance "<what must be true, for this child only>"
CHOOSE <type> PER CHILD - bug, feature or task - from what the child actually is, not from the
parent's type and not from a fixed value. A child that builds something new is a feature even
when the parent is a bug; a child that is somebody running a command or reading a dashboard is
a task. This line used to read '-t bug' and four separate splits on 2026-08-25/26 dutifully
created features as bugs, flagged it, and had it corrected afterwards - which is the right
instinct followed from the wrong instruction, so the instruction is what changed.
Add 'bd label add <child> needs-decision' (a choice only a person can make) or 'needs-access'
(something only they can run - a deploy, a dashboard, a device) for any child marked as needing
a person, with a
note saying exactly what the person must decide or do.

CHECK EVERY CHILD'S LABELS AFTER CREATING IT. bd copies the PARENT's labels onto a child,
and that has gone wrong three different ways: a leaf child inheriting 'umbrella' is treated
by the queue as a parent whose children do the work, so it is never offered to anybody; a
child inheriting the parent's REPO label routes the work at the wrong repository - an
extension change labelled 'site' would be attempted in the Rails app; and an inherited
'roadmap' defers something nobody deferred. Read the labels back and correct them.

Set every child's status explicitly as you create it - open for the ready ones, open plus
the right parking label for the rest - needs-decision for a choice, needs-access for something
only a person can run - and do it BEFORE you finish. Children inherit the
parent's in_progress state on creation, which misrepresents them as work underway. Two
warnings about that correction:
- Label the decision children in the same breath as you open them. A child that is open and
  unlabelled for even a few seconds can be picked up by the supervisor and handed to an
  agent, which is how a "Decide whether..." issue ends up being attempted.
- Never touch the status of an issue that is not one you just created. If a child was
  claimed while you worked, leave that claim alone - something is running against it.

Then park the parent so it stops being picked up as work:CHECK BEFORE YOU LABEL: read the issue's notes first. If they record the OWNER clearing a
parking label - phrases like "removing it again", "label re-applied after being cleared",
"unparked" - then DO NOT add the label back. Say in your result that you would have parked it
and why, and let the supervisor take it up with a person. A label the owner removed is their
decision; re-applying it automatically is the pipeline overruling them, and it has already
happened twice on app-i6yt and app-233a. Writing the QUESTION into the notes is always allowed and
is what they asked for - a bare label with no question cannot be answered.


  bd label add ${ID} umbrella
  bd update ${ID} -s open --append-notes "Split into <the child ids>, <one-line reason>. The work
  now lives in the children; this stays as the umbrella."
Use the label, not a type change: bd 0.20.1 has no --type on update, bd edit only touches
text fields, and import refuses the round trip as a collision. The queue treats 'umbrella'
exactly as it treats 'needs-feedback'. Do not write to the database directly to get around
that, and do not delete and recreate the parent - that would destroy its dependency links.
Keep the parent open. Do not close it - its children are not done.

Report the child ids you created and which are ready to be worked.

${LAW}

Never use 2>&1. Change no code, open no PR, touch no repo.`,
    { label: `split:${ID}`, phase: 'Split', model: 'sonnet' })

  log(`SPLIT ${ID} - ${triage.title}\n    into ${plan.length}: ${plan.map((c) => `[${c.repo}] ${c.title}`).join(' | ')}`)
  return {
    id: ID, title: triage.title, outcome: 'split',
    children: plan.map((c) => ({ title: c.title, repo: c.repo, autonomous: c.autonomous })),
    notes: typeof split === 'string' ? split : ''
  }
}

// A handover agent once reported "verified, issue now carries the single label needs-feedback"
// when the issue carried no label at all and was still in_progress. Appending a note was ruled
// out as the cause by experiment - it disturbs neither field - so the step simply did not do
// what it said. The queue then offered the issue straight back as ready work, which is how an
// unanswerable question gets dispatched a second time.
//
// So the handover has to show its work, and this checks it rather than believing it.
const HANDOVER = {
  type: 'object',
  required: ['verification'],
  properties: {
    verification: {
      type: 'string',
      description: 'the VERBATIM first six lines of `bd show <id>` run AFTER the changes, showing the status and labels as they now stand'
    }
  }
}

function parkedProperly(v) {
  const t = String(v || '')
  return /needs-(decision|access)|blocked-tooling|watch/i.test(t) && /\bopen\b/i.test(t)
}

if (!triage.eligible) {
  const handover = await agent(`Issue ${ID} cannot be done unattended: ${triage.reason}

Hand it to a person, from ${ROOT}:
  bd label add ${ID} <needs-decision if a choice only a person can make, needs-access if it needs a deploy/dashboard/device they have and you do not>
  bd update ${ID} -s open --append-notes "<why this needs a person, and the exact question or
  decision, written so somebody can answer it without re-reading the code>"

Then run bd show ${ID} once more and return its first six lines verbatim as 'verification',
so this can be checked. Do not paraphrase them and do not report success you have not seen:
a previous handover claimed both changes had landed when neither had, and the issue was
handed straight back out as ready work.

Change no code. Never use 2>&1.`, { label: `handover:${ID}`, phase: 'Triage', schema: HANDOVER, model: 'sonnet' })

  if (!parkedProperly(handover && handover.verification)) {
    log(`PARK FAILED ${ID} - it is NOT open + a parking label in the tracker. Park it by hand or it will be dispatched again.`)
  }
  log(`NEEDS YOU ${ID} - ${triage.title}\n    ${triage.reason}`)
  return { id: ID, title: triage.title, repo: triage.repo, outcome: 'needs_feedback', question: triage.reason }
}

const task = { id: ID, title: triage.title, repo: triage.repo, priority: triage.priority, ui: triage.ui, ticket: triage.ticket }
log(`starting ${ID} (P${task.priority}, ${task.repo}) - ${task.title}`)

let feedback = null
let brief = task.ui ? await design(task) : null
let result = null
let reworks = 0

// Outer: rebase cycles. Inner: review rounds. A rebase that goes red restarts the inner
// loop with a full budget, capped so a branch that can never sit on top of master ends up
// with a person instead of spinning.
while (!result) {
let rework = null

for (let attempt = 1; attempt <= MAX_ATTEMPTS && !result && !rework; attempt++) {
  phase('Fix')
  const work = await agent(fixPrompt(task, attempt, feedback, SLOT - 1, brief), {
    label: `fix:${task.id}${attempt > 1 ? `#${attempt}` : ''}`, phase: 'Fix', schema: WORK
  })

  if (!work) { result = { outcome: 'agent_error', at: 'fix', attempts: attempt }; break }

  if (work.status === 'needs_design') {
    if (!brief) { brief = await design(task); attempt -= 1; continue }
    result = { outcome: 'blocked', summary: 'asked for a design it had already been given' }
    break
  }
  if (work.status === 'needs_feedback') { result = { outcome: 'needs_feedback', question: work.question, attempts: attempt }; break }
  if (work.status === 'no_change_needed') { result = { outcome: 'no_change_needed', summary: work.summary }; break }
  if (work.status === 'blocked') { result = { outcome: 'blocked', summary: work.summary, attempts: attempt }; break }

  phase('Review')
  const review = await agent(reviewPrompt(task, work, attempt), {
    label: `review:${task.id}${attempt > 1 ? `#${attempt}` : ''}`, phase: 'Review', schema: REVIEW
  })

  if (review && review.approved) {
    phase('Handoff')
    const ship = await agent(handoffPrompt(task, work), { label: `handoff:${task.id}`, phase: 'Handoff', schema: SHIP, model: 'sonnet', effort: 'low' })

    // Master moved and the rebase left this red. Somebody else's change broke it, so the
    // review budget is restored and it goes back to Fix knowing what failed.
    // Kept, but the lander rebases now, so a handoff never returns needs_rework. It stays
    // because a lane that somehow does rebase should still get its budget back rather than
    // failing silently.
    if (ship && ship.status === 'needs_rework' && reworks < MAX_REWORKS) {
      reworks += 1
      rework = `Your branch was behind master. After rebasing onto current master the suite is red, and these failures are what has to be fixed before it can merge:

${ship.reworkReason || ship.notes}

This is not a rejection of your change - master moved underneath it. Read the failures
before assuming they are yours: if they belong to something merged since, they may want
fixing here or handing back, and the reviewer will judge which. The review budget has been
reset; you have ${MAX_ATTEMPTS} rounds again.`
      log(`${task.id}: rebased onto master and went red - back to Fix, budget reset (rework ${reworks} of ${MAX_REWORKS})`)
      break
    }

    result = {
      outcome: ship && (ship.status === 'verified' || ship.verified) ? 'verified' : 'handoff_failed',
      pr: work.prUrl, attempts: attempt, reworks,
      deployed: ship && ship.deployed, notes: ship && ship.notes
    }
    break
  }

  feedback = review
    ? `${review.notes}\n\nBLOCKING:\n${(review.blocking || []).map((b) => `- ${b}`).join('\n')}`
    : 'The reviewer produced no verdict. Treat the change as unreviewed and re-examine it yourself.'
  log(`${task.id}: rejected on round ${attempt} of ${MAX_ATTEMPTS}`)

  if (attempt === MAX_ATTEMPTS) {
    const ho = await agent(giveUpPrompt(task, feedback), { label: `handover:${task.id}`, phase: 'Ship', schema: HANDOVER, model: 'sonnet' })
    if (!parkedProperly(ho && ho.verification)) {
      log(`PARK FAILED ${task.id} - NOT open + a parking label in the tracker. Park it by hand or it will be dispatched again.`)
    }
    result = { outcome: 'needs_feedback', question: 'three review rounds did not converge', attempts: MAX_ATTEMPTS, reworks }
  }
}

if (rework) { feedback = rework; continue }

if (!result && reworks >= MAX_REWORKS) {
  const ho2 = await agent(giveUpPrompt(task, `Rebased onto master ${MAX_REWORKS} times and it was red every time. Master is moving faster than this branch can follow, or the change genuinely disagrees with something that landed since. Last failure:\n\n${feedback}`), { label: `handover:${task.id}`, phase: 'Ship', schema: HANDOVER, model: 'sonnet' })
  if (!parkedProperly(ho2 && ho2.verification)) {
    log(`PARK FAILED ${task.id} - NOT open + a parking label in the tracker. Park it by hand or it will be dispatched again.`)
  }
  result = { outcome: 'needs_feedback', question: `rebased ${MAX_REWORKS} times and master was red each time`, reworks }
}
}

const MARK = {
  verified: 'READY TO LAND', needs_feedback: 'NEEDS YOU', no_change_needed: 'NOTHING TO DO',
  blocked: 'BLOCKED', handoff_failed: 'NOT LABELLED', agent_error: 'AGENT DIED', split: 'SPLIT'
}
const bits = []
if (result.pr) bits.push(result.pr)
if (result.attempts > 1) bits.push(`${result.attempts} rounds`)
if (result.pr && result.outcome === 'verified') bits.push('labelled lane-verified')
if (result.question) bits.push(`asks: ${result.question}`)
if (result.summary && !result.question) bits.push(result.summary)
log(`${MARK[result.outcome] || result.outcome} ${task.id} P${task.priority} ${task.repo} - ${task.title}${bits.length ? `\n    ${bits.join('\n    ')}` : ''}`)

return { id: task.id, title: task.title, repo: task.repo, priority: task.priority, ...result }
