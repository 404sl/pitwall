export const meta = {
  name: 'devloop-refine',
  description: 'Turn a request dropped on the console into a ticket a lane can run, or into one question for a person, or close it as not work - never rewriting the request itself',
  phases: [
    { title: 'Refine', detail: 'read the request and every file dropped with it, measure the claim against origin, write the specification or the one question' },
    { title: 'Record', detail: 'append the result beside the raw text and route the issue: to the devloop, to a person, or closed' },
  ],
}

const input = (typeof args === 'string' ? JSON.parse(args) : args) || {}

if (!input.root) {
  return {
    id: input.id || null,
    outcome: 'error',
    notes: 'no root in args - refusing to run. Build the args with config.sh --refine <id>; refine.js has no filesystem access and reads its configuration from args alone.',
    releaseClaim: true,
  }
}
const ROOT = input.root
const ID_PREFIX = input.idPrefix || 'sr'
const LOCK_PREFIX = input.lockPrefix || 'devloop'
const SKILL_DIR = input.skillDir
if (!SKILL_DIR) {
  return { id: input.id || null, outcome: 'error', notes: 'skillDir was not supplied. config.sh --refine emits it; a hand-built args object must too. Refusing rather than telling a run to read WRITING-TICKETS.md and bd-note.sh from undefined/.', releaseClaim: true }
}
const ID = input.id
if (!ID) return { outcome: 'error', notes: 'no issue id given - build the args with config.sh --refine <id>', releaseClaim: true }

const ACTOR = input.actor
if (!ACTOR || typeof ACTOR !== 'string' || /[^A-Za-z0-9._-]/.test(ACTOR)) {
  return { id: ID, outcome: 'error', notes: `actor was ${JSON.stringify(ACTOR)}. Every tracker write this run makes carries --actor, and a refined ticket is assigned to that name, so it cannot be guessed: bd would stamp the git identity and the ticket would land in a person's queue. Declare "actor" in the workspace config - the name the devloop takes work under - and dispatch again.`, releaseClaim: true }
}

const REPOS = input.repos || {}
const REPO_KEYS = Object.keys(REPOS)
if (!REPO_KEYS.length) {
  return { id: ID, outcome: 'error', notes: 'no repositories in args - refusing to run. A refined ticket names a configured repository in its first line, and this config names none.', releaseClaim: true }
}

const SLOT = input.slot
if (!Number.isInteger(SLOT) || SLOT < 1) {
  return { id: ID, outcome: 'error', notes: `slot was ${JSON.stringify(SLOT)}, which no reservation names. config.sh --refine <id> reserves a lane through slot.sh and emits the number it got; a hand-built args object has no reservation. Refusing rather than running on a lane this run does not hold.`, releaseClaim: true }
}
const LANE = SLOT + 1
const LANE_LOCK = `/tmp/${LOCK_PREFIX}-lane-${LANE}.lock`
const OWNER_FILE = `/tmp/${LOCK_PREFIX}-lane-${LANE}.owner`
const SLOT_FILE = `/tmp/${LOCK_PREFIX}-slots/${SLOT}`
const GIVEN_BACK = new Set(['released', 'already_gone'])
const OWNER = ID

const SCRATCH = `/tmp/${LOCK_PREFIX}-scratch/${ID}`
const INTAKE_LABEL = 'unrefined'
const INTAKE_DIR = '.pitwall-intake'
const INTAKE_PATH = `${ROOT}/${INTAKE_DIR}/${ID}`
const WRITING_TICKETS = `${SKILL_DIR}/WRITING-TICKETS.md`
const SESSION = `refine-${ID}`

function baseOf(repo) { return (REPOS[repo] || {}).defaultBranch || 'master' }
function isWorkspace(repo) { return (REPOS[repo] || {}).role === 'workspace' }
function repoPath(repo) {
  const p = (REPOS[repo] || {}).path || repo
  return p === '.' ? ROOT : `${ROOT}/${p}`
}
const CHECKOUT_KEYS = REPO_KEYS.filter((k) => !isWorkspace(k))
const WORKSPACE_KEY = REPO_KEYS.find(isWorkspace) || null
const SHARED_BASE = [...new Set(CHECKOUT_KEYS.map(baseOf))]
const BASE = SHARED_BASE.length === 1 ? SHARED_BASE[0] : '<that repository\'s default branch, from the table>'

function workspaceRouting() {
  if (!WORKSPACE_KEY) return ''
  return [
    '',
    'Work that lives in no checkout - tracker edits, files in the workspace root outside every',
    'checkout above - routes to \'' + WORKSPACE_KEY + '\'. A path that IS inside a checkout routes to that',
    'checkout whatever the request calls the work.',
  ].join('\n')
}

function reposTable() {
  return REPO_KEYS.map((k) => {
    if (isWorkspace(k)) return `  ${k}  ->  ${repoPath(k)}  the workspace root itself: tracker edits and root-level files, no pull request`
    const slug = (REPOS[k] || {}).slug
    const tag = slug ? '  (' + slug + ')' : ''
    return `  ${k}  ->  ${repoPath(k)}${tag}  lands on origin/${baseOf(k)}`
  }).join('\n')
}

const SHELL_FIRST = `EVERY COMMAND THAT RUNS git STARTS WITH THESE TWO EXPORTS, and so does every command that
runs a script which does:

  export GIT_CONFIG_GLOBAL=/dev/null BUNDLE_USER_CONFIG=/dev/null && <your command>

Each command you run is its own shell, so exporting them once at the start reaches nothing after
it - they go at the front of the command. A home-directory config that cannot be read presents as
anything but itself: every git command fails with 'unknown error occurred while reading the
configuration files', and every bundler-fronted command hangs with no output at all. The two
exports cost a readable config nothing and are not conditional. Nothing in this run writes a
commit, so no identity is needed here.`

const REFINE = {
  type: 'object',
  required: ['outcome', 'repo', 'raw', 'assignee', 'attachments', 'measured', 'notes'],
  properties: {
    outcome: { enum: ['refined', 'needs_answer', 'not_work'] },
    repo: {
      enum: [...REPO_KEYS, 'unknown'],
      description: 'the configured key the work lives in, from the table in the brief. unknown means you could not name one, which is never a refined ticket.',
    },
    raw: { type: 'string', description: 'the description field exactly as bd show --json printed it - the request as typed' },
    assignee: { type: 'string', description: 'the assignee field as bd show --json printed it, or an empty string' },
    attachments: {
      type: 'object',
      required: ['read', 'unreadable'],
      properties: {
        read: { type: 'array', items: { type: 'string' }, description: 'every dropped file you opened and read, by name' },
        unreadable: { type: 'array', items: { type: 'string' }, description: 'every dropped file you could not read, by name, each with the reason after a dash' },
      },
    },
    measured: { type: 'string', description: 'what you read or ran and what it showed - files with line numbers, counts, quoted strings, commands with their output. Empty only for not_work' },
    specification: { type: 'string', description: 'refined: the ticket body after its Repo line, in the shape WRITING-TICKETS.md defines - line one what to do, then traps, evidence, acceptance' },
    understood: { type: 'string', description: 'needs_answer: what the request was understood to ask and what was established, so the person answers from this rather than re-reading the code' },
    question: { type: 'string', description: 'needs_answer: the one specific question. One sentence, one decision' },
    why: { enum: ['note', 'duplicate', 'done'], description: 'not_work: which of the three it is' },
    duplicateOf: { type: 'string', description: 'not_work, duplicate: the id of the issue that already carries it' },
    reason: { type: 'string', description: 'not_work: the evidence - where on origin the done thing is, or what makes it a note rather than work' },
    notes: { type: 'string', description: 'anything else the record of this run should carry, including anything WRITING-TICKETS.md gets wrong' },
  },
}

const RECORD = {
  type: 'object',
  required: ['status', 'noteLanded', 'labels', 'assignee', 'issueStatus', 'descriptionUnchanged', 'notes'],
  properties: {
    status: { enum: ['recorded', 'failed'] },
    noteLanded: { type: 'boolean', description: 'bd-note.sh exited 0 and printed appended, or the close reason was accepted' },
    labels: { type: 'array', items: { type: 'string' }, description: 'the labels field from bd show --json AFTER your writes' },
    assignee: { type: 'string', description: 'the assignee field from bd show --json AFTER your writes, or an empty string' },
    issueStatus: { type: 'string', description: 'the status field from bd show --json AFTER your writes' },
    descriptionUnchanged: { type: 'boolean', description: 'the description field AFTER your writes is byte-for-byte the text this brief calls the raw request' },
    notes: { type: 'string', description: 'everything the commands printed that was not the expected line, verbatim' },
  },
}

const LANE_BACK = {
  type: 'object',
  required: ['lane', 'slot'],
  properties: {
    lane: { enum: ['released', 'not_mine', 'already_gone', 'still_held', 'refused'], description: 'the word release-lane.sh printed after lane:, lowercased - it reports its own outcome and you are not asked to judge it. refused means the command was not permitted to run at all, so nothing was printed' },
    slot: { enum: ['released', 'not_mine', 'already_gone', 'still_held', 'refused'], description: 'the word it printed after slot:, lowercased, or refused when the command was not permitted to run' },
    notes: { type: 'string', description: 'everything it printed, verbatim - or what refused the command, in its own words' },
  },
}

function releaseLanePrompt() {
  return `Give slot ${SLOT} back, and lane ${LANE} with it if anything took it. Run this command once,
exactly as it stands, and report what it printed:

  bash ${SKILL_DIR}/release-lane.sh --lane ${LANE_LOCK} --slot ${SLOT_FILE} --owner '${OWNER}'

Every value is already in the command. There is nothing to look up, substitute or confirm first,
and nothing for you to judge: the script proves ownership itself and removes only what names this
run. This run took no lane lock, so 'lane: ALREADY_GONE' is the expected answer for the lane and
is not a fault; the slot is what it holds.

Report the word after 'lane:' as 'lane', the word after 'slot:' as 'slot', lowercased, and
everything it printed as 'notes'. If the command is not permitted to run at all, report 'refused'
for both and say what refused it in 'notes'. Remove nothing by hand, run no other command, and
never use 2>&1.`
}

const PLAIN_SLOT = `if [ ! -e ${SLOT_FILE} ]; then echo "slot: ALREADY_GONE"; elif [ "$(head -n 1 ${SLOT_FILE})" = "${OWNER}" ]; then rm -f ${SLOT_FILE} && echo "slot: RELEASED" || echo "slot: STILL_HELD"; else echo "slot: NOT_MINE - $(head -n 1 ${SLOT_FILE})"; fi`

function settle(path, answer, refused, byHand) {
  if (GIVEN_BACK.has(answer)) return answer
  if (answer === 'not_mine') return `not_mine - ${path} does not record ${OWNER}, so nothing was removed and nothing should be`
  if (answer === 'refused' || (refused && !answer)) return `REFUSED - no release step was permitted to give ${path} back, so it is leaked if it still names ${OWNER}. Release it on reading this: ${byHand}`
  return `LEAKED - ${path} was not given back, or the release step answered nothing. Read it before removing anything: clear it if it records this run, and leave it alone if it records another.`
}

function refinePrompt() {
  return `Refine one request into a ticket a lane can run - or say, precisely, why that cannot be done yet.

Issue: ${ID}. It carries the label '${INTAKE_LABEL}': somebody typed it into the console as a
request and the console recorded the text exactly as typed, with whatever files were dropped
beside it. Nothing in it has been verified, and a request is not a ticket. Read it from ${ROOT}:

  export BEADS_DIR=${ROOT}/.beads
  cd ${ROOT} && bd show ${ID} --json

READ --json, NEVER THE RENDERED OUTPUT: the renderer strips angle brackets and wraps long values.
The 'description' field is the request as typed. 'metadata.intake.raw' is the same text, and
'metadata.intake.files' lists the dropped files as paths relative to ${ROOT}. Return the
description as 'raw' and the assignee as 'assignee', exactly as printed. The 'notes' field is
earlier rounds: when this run asked a question before, a person's answer is there, and the answer
is the reason the issue is in front of you again. Read every note before you form a view.

Do NOT judge the issue's status. It is in_progress because this run holds it, not because
somebody else does.

THE STANDARD IS ${WRITING_TICKETS}. Read the whole file before anything else. It defines the
shape a ticket takes, what earns its length and what does not, the measured cost of getting it
wrong, when a ticket is two tickets, and what to do when the truth is written down elsewhere.
Refinement follows that document. This brief does not restate it, and you do not improve on it:
if you find it wrong, say so in 'notes' and follow it anyway. A fork of the standard in one
ticket is worse than a flaw in the standard.

READ EVERY DROPPED FILE BEFORE YOU FORM A VIEW. They live under ${INTAKE_PATH}/ - list the
directory itself as well as reading the metadata, because a recording that failed half-way
leaves files on disk the ticket does not list. Open images with your file-reading tool, which
shows you the picture. A screenshot is usually the whole report for anything visual, and a
refinement that ignores the image and works from the sentence describes the wrong defect. A file
you cannot read - a format you cannot open, a zero-byte file, a path that is not there - goes in
'attachments.unreadable' with the reason, and the specification or question you write says so
in as many words. Refining silently without it is the failure, not the unreadable file.

THE REPOSITORIES this workspace configures, by key. A refined ticket names one of these in its
first line, because a lane cannot start without it:
${reposTable()}
${workspaceRouting()}

MEASURE, DO NOT RESTATE. The request says something is wrong. Your job is to establish what is
actually true, by reading the code or running the command: name the file and the line, count
the rows, quote the string, paste the output. A restatement that names no file and measures
nothing is longer than the request and no more actionable, and the standard already says so
under what does not earn its length. Everything you read or ran goes in 'measured', with what it
showed.

READ THE CODE FROM origin/${BASE}, NEVER FROM A CHECKOUT'S OWN HEAD. Every lane branches from
origin and lands from a worktree, so nobody fast-forwards the root checkouts: on 2026-09-12 one
was 35 merges behind, and a file that had been on origin for days was reported as not existing.
Fetch first, because a remote-tracking ref nobody has fetched is stale one level down:

  git -C <checkout> fetch origin --quiet
  git -C <checkout> ls-tree --name-only origin/${BASE} <path>
  git -C <checkout> show origin/${BASE}:<file>
  git -C <checkout> grep -n '<pattern>' origin/${BASE} -- <path>

Not 'git show HEAD:<file>', not 'ls <checkout>/<path>', not 'cat <checkout>/<file>'.

THE ROOT CHECKOUTS ARE PEOPLE'S WORKING COPIES, AND THIS RUN HOLDS NO LANE LOCK. Run nothing that
writes into one: no builds, no installs, no test suites, no edits, no worktrees, no checkouts of
another branch. A suite run here would share a test database with a lane that does hold the
lock. When measuring genuinely needs a build or a suite, write that as the lane's first step in
the specification and say what you expect it to show. Read-only commands that print and change
nothing are fine, from the checkout or from origin.

${SHELL_FIRST}

THREE OUTCOMES, AND THE SECOND IS NOT A FAILURE.

refined     The request is determined enough to specify. 'specification' is the ticket body in the
            shape the standard defines: line one is what to do, as an instruction; then only the
            traps - each a specific wrong-but-obvious fix, named; then the evidence, which is your
            measurement, with files and lines; then acceptance a lane can check without judgement.
            Name 'repo' as one key from the table; the record step writes 'Repo: <key> (<path>)'
            above your text, so do not write that line yourself. 'unknown' is not a refined
            ticket - nothing reaches a lane without the repository named, and this run refuses
            the combination rather than recording it.

            If the request has two halves that fix independently, say so in line one and give each
            its own acceptance, clearly separated. The lane's triage splits a ticket that bundles
            work; that is its job, and yours is to make the seam visible.

needs_answer  The request is underdetermined: a competent engineer reading it, with your
            measurements in hand, could build two different things and not know which was wanted.
            'understood' is what you established - the measurement included - so the person
            answers from it rather than re-reading the code. 'question' is ONE specific question,
            one sentence, one decision. Not a questionnaire, not a menu of everything you
            wondered about: the second question waits for the second round.

            BEFORE YOU CHOOSE THIS, ASK WHETHER THE OWNER'S ANSWER WOULD DIFFER FROM ANY COMPETENT
            ENGINEER'S. If it would not, it is not their question: decide it, write what you chose
            and why into the specification's traps, and return refined. Which of two shapes, where
            to dedupe, what a fallback should be, how a report formats a collision - none of those
            is the owner's. What IS theirs: what the product should do, who it is for, what it is
            worth, what it is called, anything irreversible once shipped. That is a much smaller
            set than "somebody must decide". Also look for an answer that already exists:
            'bd search <the subject>' for a sibling that settled it, and the notes on this issue.

not_work    It is a note, a duplicate, or already done. 'why' says which. For a duplicate, run
            'bd search <a distinctive phrase from the request>' and put the id in 'duplicateOf';
            for done, 'reason' says where on origin/${BASE} the thing already is - a path, a commit
            - not that you believe it; for a note, 'reason' says what it is a note about and why
            no action follows from it. The record step closes the issue with that text, so write
            it for the person who reopens it.

INVENTING CERTAINTY IS THE WHOLE RISK. A terse request is often underdetermined, and a refiner
that guesses produces a confident specification for the wrong thing - which a lane then
implements, reviews, merges and deploys, because every downstream step trusts the ticket. A vague
ticket stalls visibly; a confidently wrong one ships. So 'refined' is for what you measured, not
for what you inferred, and a guess dressed as a specification is the one output this step must
never produce. When you are choosing between refined and needs_answer, the measurement decides:
if the thing the request points at exists and does what the request says, refine; if you had to
suppose what the person meant, ask.

THE RAW TEXT IS NEVER OVERWRITTEN, and you write nothing to the tracker here at all. The record
step that follows appends what you return as a note beside the request and leaves the
description, the title and the metadata exactly as they are, so a reader can always see what was
actually asked for and judge the refinement against it. Return the text; do not run bd update,
bd close or bd-note.sh yourself.

Never use 2>&1. Absolute paths everywhere.`
}

function joinLines(items) { return items.length ? items.map((s) => `  ${s}`).join('\n') : '  (none)' }

function attachmentsBlock(refined) {
  const a = refined.attachments || { read: [], unreadable: [] }
  const read = a.read || []
  const unreadable = a.unreadable || []
  if (!read.length && !unreadable.length) return 'Files dropped with the request: none.'
  const lines = ['Files read:', joinLines(read)]
  if (unreadable.length) lines.push('Files that could NOT be read - the refinement above was written without them:', joinLines(unreadable))
  return lines.join('\n')
}

function trimmed(text, fallback) {
  const t = (text || '').trim()
  return t || fallback || ''
}

function refinerNotes(refined) {
  const t = trimmed(refined.notes)
  return t ? '\n\nRefiner\'s notes: ' + t : ''
}

function refinedNote(refined) {
  return `REFINED. The request above is unchanged; this is the specification written beside it.

Repo: ${refined.repo} (${repoPath(refined.repo)})
${trimmed(refined.specification)}

Measured:
${trimmed(refined.measured, '  (nothing recorded)')}

${attachmentsBlock(refined)}${refinerNotes(refined)}`
}

function questionNote(refined) {
  return `NEEDS AN ANSWER. The request above is unchanged and was not refined: it is underdetermined.

Understood so far:
${trimmed(refined.understood, '  (nothing recorded)')}

Measured:
${trimmed(refined.measured, '  (nothing recorded)')}

QUESTION: ${trimmed(refined.question)}

Answer as a note here and remove needs-decision. The request keeps its ${INTAKE_LABEL} label, so
the next refinement round reads the answer and writes the specification.

${attachmentsBlock(refined)}${refinerNotes(refined)}`
}

function closeReason(refined) {
  const which = refined.why === 'duplicate'
    ? 'duplicate of ' + (refined.duplicateOf || '<no id given>')
    : refined.why === 'done' ? 'already done' : 'a note, not work'
  const measured = trimmed(refined.measured)
  return `NOT WORK - ${which}. ${trimmed(refined.reason)}${measured ? '\n\nMeasured:\n' + measured : ''}

${attachmentsBlock(refined)}`
}

function marked(text) {
  return `----- BEGIN TEXT -----
${text}
----- END TEXT -----`
}

function recordCommon(refined) {
  return `Record the outcome of refining ${ID} on the tracker, exactly as written here, then read it back.

The request text on that issue is sacred: the description is what a person typed, and the value
of the note you are about to write depends on a reader being able to hold the two side by side.
So you never run 'bd update' with -d, --description, --body-file, --stdin, --title, --notes,
--metadata or --set-metadata on this issue - the first six replace the request or its title, and
the last two replace the 'intake' object that carries the raw text and the file list. Only the
commands below, exactly as they stand, with nothing added.

${SHELL_FIRST}

Every tracker write below carries the actor '${ACTOR}': bd takes it as --actor on the command, and
bd-note.sh, which runs bd itself, takes it as BEADS_ACTOR set on its own command line. Neither is
optional and neither comes from a shell export. First, once:

  export BEADS_DIR=${ROOT}/.beads
  mkdir -p ${SCRATCH}

For reference, the raw request as the refiner read it - you compare the description against this
at the end and change nothing to make them match:

${marked(refined.raw || '')}`
}

function recordRefinedPrompt(refined) {
  return `${recordCommon(refined)}

1. Write this text to ${SCRATCH}/refine-note.txt with your file-writing tool, byte for byte as it
   stands between the markers, markers excluded. Not through a shell string: a backtick or a
   dollar-paren in it would be evaluated before bd saw it, and the note would land with the line
   that carried its evidence cut off.

${marked(refinedNote(refined))}

2. Append it beside the request. The script takes the write lock, stamps the note, reads it back,
   and retries; it is the only writer allowed here:

  cd ${ROOT} && BEADS_ACTOR=${ACTOR} PITWALL_SESSION=${SESSION} bash ${SKILL_DIR}/bd-note.sh ${ID} --note-file ${SCRATCH}/refine-note.txt

   It prints 'bd-note: appended to ${ID}' on success. A non-zero exit means the note did NOT land
   and the text is on stderr: report status 'failed' and stop - do not route an issue whose
   specification is not on it.

3. Route it to the devloop, in one command. The label comes off because the request is now a
   ticket; the assignee moves because the devloop takes only what is assigned to it; open makes it
   visible to the queue:

  cd ${ROOT} && bd --actor ${ACTOR} update ${ID} --remove-label ${INTAKE_LABEL} -a ${ACTOR} -s open

4. Read it back and report what is there now - labels, assignee, status, and whether the
   description is byte-for-byte the raw request quoted above:

  cd ${ROOT} && bd show ${ID} --json

Never use 2>&1.`
}

function recordQuestionPrompt(refined) {
  return `${recordCommon(refined)}

1. Write this text to ${SCRATCH}/refine-note.txt with your file-writing tool, byte for byte as it
   stands between the markers, markers excluded. Not through a shell string: a backtick or a
   dollar-paren in it would be evaluated before bd saw it, and the question would land cut off.

${marked(questionNote(refined))}

2. Append it beside the request. The script takes the write lock, stamps the note, reads it back,
   and retries; it is the only writer allowed here:

  cd ${ROOT} && BEADS_ACTOR=${ACTOR} PITWALL_SESSION=${SESSION} bash ${SKILL_DIR}/bd-note.sh ${ID} --note-file ${SCRATCH}/refine-note.txt

   It prints 'bd-note: appended to ${ID}' on success. A non-zero exit means the note did NOT land
   and the text is on stderr: report status 'failed' and stop - a parked issue whose question is
   not written on it is one nobody can answer.

3. Park it for a person, in one command. The assignee stays where intake put it - the planning
   session - and the ${INTAKE_LABEL} label stays on, so that when the person answers and removes
   needs-decision the request is refined again with the answer in front of it:

  cd ${ROOT} && bd --actor ${ACTOR} update ${ID} --add-label needs-decision -s open

4. Read it back and report what is there now - labels, assignee, status, and whether the
   description is byte-for-byte the raw request quoted above:

  cd ${ROOT} && bd show ${ID} --json

Never use 2>&1.`
}

function recordClosePrompt(refined) {
  return `${recordCommon(refined)}

1. Write this text to ${SCRATCH}/close-reason.txt with your file-writing tool, byte for byte as it
   stands between the markers, markers excluded. Not through a shell string: a backtick or a
   dollar-paren in it would be evaluated before bd saw it.

${marked(closeReason(refined))}

2. Close it with that reason, in one command:

  cd ${ROOT} && bd --actor ${ACTOR} close ${ID} --reason-file ${SCRATCH}/close-reason.txt

   Report noteLanded true when it printed the closed line, false with the output verbatim when it
   did not.

3. Read it back and report what is there now - labels, assignee, status, and whether the
   description is byte-for-byte the raw request quoted above:

  cd ${ROOT} && bd show ${ID} --json

Never use 2>&1.`
}

async function giveBack(prompt, label, schema) {
  try {
    return await agent(prompt, { label, phase: 'Record', schema, model: 'haiku', effort: 'low' })
  } catch (e) {
    log(`${label}: the release step died before answering - ${e && e.message ? e.message : String(e)}`)
    return null
  }
}

function unanswered(answer) {
  return !answer || answer.lane === 'refused' || answer.slot === 'refused'
}

let slotClaim = `LEAKED - the release step never reported. Read ${SLOT_FILE} before touching anything.`
let result = null

try {

phase('Refine')

const refined = await agent(refinePrompt(), { schema: REFINE, phase: 'Refine', label: `refine:${ID}` })

if (!refined) {
  result = { id: ID, outcome: 'error', notes: 'the refine step returned nothing - the issue is still labelled unrefined and still in_progress', releaseClaim: true }
} else if (refined.outcome === 'refined' && !REPO_KEYS.includes(refined.repo)) {
  result = {
    id: ID,
    outcome: 'error',
    notes: `the refine step returned a specification with repo ${JSON.stringify(refined.repo)}, which is not a configured key (${REPO_KEYS.join(', ')}). Nothing reaches a lane without the repository named, so nothing was written: the request is unchanged and still labelled ${INTAKE_LABEL}. Its measurement, so it is not lost: ${refined.measured || '(none)'}`,
    releaseClaim: true,
  }
} else if (refined.outcome === 'needs_answer' && !(refined.question || '').trim()) {
  result = {
    id: ID,
    outcome: 'error',
    notes: `the refine step said the request needs an answer and asked no question. A parked issue with no question on it is one nobody can answer, so nothing was written: the request is unchanged and still labelled ${INTAKE_LABEL}. What it understood: ${refined.understood || '(none)'}`,
    releaseClaim: true,
  }
} else {

phase('Record')

const prompt = refined.outcome === 'refined'
  ? recordRefinedPrompt(refined)
  : refined.outcome === 'needs_answer' ? recordQuestionPrompt(refined) : recordClosePrompt(refined)

const recorded = await agent(prompt, { schema: RECORD, phase: 'Record', label: `record:${ID}` })

const labels = (recorded && recorded.labels) || []
const expected = refined.outcome === 'refined'
  ? { ok: recorded && recorded.status === 'recorded' && recorded.noteLanded && !labels.includes(INTAKE_LABEL) && recorded.assignee === ACTOR && recorded.issueStatus === 'open',
      want: `no ${INTAKE_LABEL} label, assignee ${ACTOR}, status open` }
  : refined.outcome === 'needs_answer'
    ? { ok: recorded && recorded.status === 'recorded' && recorded.noteLanded && labels.includes('needs-decision') && labels.includes(INTAKE_LABEL) && recorded.issueStatus === 'open',
        want: `labels needs-decision and ${INTAKE_LABEL}, status open` }
    : { ok: recorded && recorded.status === 'recorded' && recorded.noteLanded && recorded.issueStatus === 'closed',
        want: 'status closed' }

const rawKept = recorded ? recorded.descriptionUnchanged === true : false

result = {
  id: ID,
  outcome: expected.ok && rawKept ? refined.outcome : 'error',
  repo: refined.outcome === 'refined' ? refined.repo : null,
  question: refined.outcome === 'needs_answer' ? refined.question : null,
  why: refined.outcome === 'not_work' ? refined.why : null,
  attachments: refined.attachments,
  labels,
  assignee: recorded ? recorded.assignee : null,
  issueStatus: recorded ? recorded.issueStatus : null,
  rawUnchanged: rawKept,
  notes: expected.ok && rawKept
    ? (recorded.notes || '')
    : `the record step ${recorded ? `reported ${recorded.status}` : 'returned nothing'}; wanted ${expected.want}${rawKept ? '' : ', and the description unchanged'}, read back labels ${JSON.stringify(labels)}, assignee ${JSON.stringify(recorded ? recorded.assignee : null)}, status ${JSON.stringify(recorded ? recorded.issueStatus : null)}${recorded && recorded.descriptionUnchanged === false ? '. THE DESCRIPTION CHANGED - the raw request is no longer what was typed; metadata.intake.raw still holds it' : ''}. ${recorded && recorded.notes ? recorded.notes : ''}`,
}

}

} finally {
  const back = await giveBack(releaseLanePrompt(), `release:${ID}`, LANE_BACK)
  const refused = unanswered(back)
  slotClaim = settle(SLOT_FILE, back && back.slot, refused, PLAIN_SLOT)
  if (!GIVEN_BACK.has(back && back.slot)) {
    log(`slot ${SLOT}: ${slotClaim}${back && back.notes ? `\n    ${back.notes}` : ''}`)
  }
}

return { ...result, slot: slotClaim }
