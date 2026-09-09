#!/bin/bash
# Read-only scan for issues stuck in a state nothing will move them out of.
#
#   triage-scan.sh          print findings, or CLEAN
#   triage-scan.sh --quiet  print nothing when clean (exit 0); findings exit 1
#
# NO LLM, NO WRITES. This exists so that the expensive part - an agent reading tickets and
# deciding - runs only when there is something to decide. Costing nothing means it can run
# every fifteen minutes forever.
#
# WHAT IT LOOKS FOR. Every one of these was found by hand on 2026-08-21, each after sitting
# unnoticed for hours or days, and each is invisible to the ready queue by construction:
#
#   A unlabelled hand-back    the notes say a person was asked; no label says so, so the queue
#                             offers it as work. Six at once, three in the top eight.
#   B answered but parked     the question was answered in another session; nothing removed the
#                             label, so the answer never reaches the queue. Two found, one a P1
#                             the owner had decided the day before.
#   C umbrella, no children   the label means "the work is in the children" and there are none.
#                             The queue skips it as not-work and nothing beneath it exists.
#                             app-wkl1.4 held two P1 items this way.
#   D umbrella, all closed    every child is done; the parent stays open and keeps blocking
#                             whatever depends on it.
#   E stale claim             in_progress with no worktree and nothing running. A died lane
#                             holds the issue out of the queue indefinitely.
#   F unlabelled exclusion    the text excludes itself from unattended work ("stays with a
#                             person", "never unattended") but carries no label. app-i6yt was
#                             P1, decided whether a paid checkout is honoured, and was next
#                             in line to be dispatched.
#
# It reports; it never edits. Judging these needs reading, and reading is the agent's job.

# ABSOLUTE, resolved before the cd below. Left relative, `bash triage-scan.sh` from inside the
# skill directory turns this into "./config.sh", the cd to the workspace root moves out from
# under it, and every later read of the config comes back empty - which the merge-queue check
# then reads as "no pull requests are waiting" and says nothing at all. It behaved exactly
# that way on 2026-08-24: identical scans, one reporting the queue and one silent, depending
# only on which directory the caller happened to be in.
CFG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
ROOT="${DEVLOOP_ROOT:-$(bash "$CFG" root 2>/dev/null)}"
# NO FALLBACK TO A NAMED WORKSPACE. This line used to read
# ROOT="${ROOT:-the workspace root}", so a scan run where the config could
# not be resolved reported ANOTHER WORKSPACE's tracker as though it were the caller's. queue-watch.sh
# calls this, so a monitor in another workspace would emit this project's stuck issues as its own
# events. Found on 2026-09-09 by running the watcher from /tmp after fixing its other two
# hardcodes - and only then, because the faults hid each other: each alone still produced
# plausible output, so neither looked wrong until the other was gone.
if [ -z "${ROOT:-}" ] || [ ! -d "${ROOT}/.beads" ]; then
  echo "triage-scan.sh: no workspace root with a .beads tracker - refusing to scan." >&2
  echo "                Guessing one reports another project's issues as though they were yours." >&2
  echo "                Run from the workspace root, or set DEVLOOP_ROOT." >&2
  exit 3
fi

# /tmp is shared across every project on this machine, so the lock paths are namespaced by the
# workspace's lockPrefix rather than fixed. Read it here rather than hardcoding: two projects
# with the same prefix collide on the lane locks, and the lane lock is the only thing stopping
# two lanes from sharing a test database.
PFX="$(bash "$CFG" lockPrefix 2>/dev/null || echo devloop)"

cd "$ROOT" || exit 1
QUIET=0
[ "$1" = "--quiet" ] && QUIET=1

# ts-all is the ONLY file carrying blocked and deferred issues - ts-open, ts-run and ts-closed
# each hold their own status and nothing else. So when this one command fails, those issues
# vanish from the child lookup while their closed siblings survive, and every umbrella holding
# a blocked child looks finished: category C then says "remove the umbrella label" and D says
# "all children closed, this can close". Both are wrong, and D would write live residual scope
# into a closed issue.
#
# It failed exactly this way at 14:17 on 2026-08-23: five false C/D findings, an agent spent to
# rule them out, and a clean run a minute later over the same tracker. So it is retried here and
# checked below rather than trusted - the closed file got that guard and this one never did.
bd list --json               2>/dev/null > /tmp/${PFX}-ts-all.json
# The path arrives as an argument, NOT interpolated into the program text. Written the obvious
# way - f"/tmp/{PFX}-..." inside single quotes - PFX is a Python name that does not exist, the
# guard raises NameError on every run, and a check that always fails is a check that never
# checks: the retry below fired unconditionally and the emptiness it was meant to catch went
# unexamined. The same mistake has been made three times in this skill; the fix is always argv.
if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if (d if isinstance(d,list) else d.get("issues",[])) else 1)' "/tmp/${PFX}-ts-all.json" 2>/dev/null; then
  sleep 1
  bd list --json 2>/dev/null > /tmp/${PFX}-ts-all.json
fi
bd list --status open --json 2>/dev/null > /tmp/${PFX}-ts-open.json
bd list --status in_progress --json 2>/dev/null > /tmp/${PFX}-ts-run.json
# Closed issues, and the python below REQUIRES this file - it reads it to find an umbrella's
# children. Without it the closed set is empty, every child that has shipped becomes invisible,
# and a finished umbrella looks childless. That is not a cosmetic false positive: category C
# tells the reader to remove the umbrella label, which would drop a completed epic straight back
# into the ready queue, and category D - "all children closed, this can close" - could never fire
# at all. It was missing for the first several hours this script ran.
bd list --status closed --json 2>/dev/null > /tmp/${PFX}-ts-closed.json

# The tracker scan and the merge-queue scan below are INDEPENDENT findings and either can
# fire alone, so this exit code is captured rather than left to end the script. It was not,
# for one revision: the queue check was appended after this and silently swallowed every
# tracker finding, which is the worst possible failure for a script whose whole job is to
# notice things.
# --- H: an open PR nothing downstream is watching -----------------------------
# A lane that ends BLOCKED-with-a-branch leaves an open, UNLABELLED pull request. The lander
# only ever looks at PRs carrying lane-verified, so that PR is watched by nothing: every scan
# below reports the pipeline healthy while a finished fix sits in it. It happened to #527 on
# 2026-08-26 - a P1, stranded by the Actions outage, found only because its worktree happened
# to go stale. Had the lane tidied up after itself, category G would never have fired and
# nothing else would ever have looked.
#
# THIS MUST PRINT BEFORE EVERYTHING ELSE. The caller decides whether to act by testing whether
# the output BEGINS WITH "CLEAN", so a finding emitted after the tracker block is invisible no
# matter what exit code accompanies it.
#
# A PR is legitimately unlabelled while its own lane is still working on it, so a branch whose
# issue still holds a slot is skipped. The slot registry is the right source: it is written at
# dispatch, unlike the lane lock, which appears only minutes later.
ORPHANS=""
# THE REPOSITORIES COME FROM THE WORKSPACE CONFIG. This loop used to name
# one workspace-site/-ext/-docs literally, so a scan pointed at any other workspace still
# reported THIS project's orphaned pull requests as though they were the caller's - and did so
# even after a root guard was added above, because the loop never consulted the root at all.
# That is how it was found on 2026-09-09: the guard passed (the test directory happened to
# contain a .beads) and the leak continued regardless, which is the lesson - a guard on one
# input does not constrain code that reads a different one.
_SLUGS="$(bash "$CFG" --land 2>/dev/null | python3 -c "
import json,sys
try: cfg = json.load(sys.stdin)
except Exception: raise SystemExit
for r in (cfg.get('repos') or {}).values():
    slug = (r or {}).get('slug')
    if slug: print(slug)
" 2>/dev/null)"
if [ -n "$_SLUGS" ] && command -v gh >/dev/null 2>&1; then
  for _slug in $_SLUGS; do
    _repo="${_slug#*/}"
    # A FAILED LISTING MUST NOT LOOK LIKE "NO ORPHANS". GitHub being unreachable is precisely
    # when orphans get created - #527 was stranded by an Actions outage - so swallowing the
    # error would blind the check at the only moment it matters. It is a warning, not a
    # finding: it must not turn a clean tick into a dispatch of a paid agent, and it goes to
    # stderr so it cannot land on the first line and break the begins-with-CLEAN contract.
    if ! _out="$(gh pr list --repo "$_slug" --state open --json number,headRefName,labels \
              --limit 50 2>/dev/null)"; then
      echo "warning: could not list PRs for $_repo - orphan check is incomplete this run" >&2
      continue
    fi
    ORPHANS="$ORPHANS$(printf '%s' "$_out" | python3 -c '
import json, sys, os, glob, subprocess
repo, pfx = sys.argv[1], sys.argv[2]
held = set()
for f in glob.glob("/tmp/%s-slots/*" % pfx):
    try:
        held.add(open(f).read().strip())
    except OSError:
        pass
try:
    prs = json.load(sys.stdin)
except Exception:
    sys.exit(0)
PARK = {"needs-decision", "needs-access", "roadmap", "blocked-tooling", "watch", "umbrella"}

def parked(issue_id):
    """A PR whose issue is parked is being held on purpose, not stranded.

    Without this the check has no acknowledgment path at all. A lane told to end
    BLOCKED-with-a-branch - which is a real instruction, app-gzgg carried it - leaves exactly
    the shape this scan flags, and would re-flag it on every tick forever, spending an agent
    each time to rediscover a state somebody already knows about. The tracker findings have
    TRIAGE_MARK for that; this category has nothing, so parking the issue is the signal.
    """
    try:
        out = subprocess.run(["bd", "show", issue_id, "--json"], capture_output=True,
                             text=True, timeout=15)
        if out.returncode != 0:
            return False        # cannot tell -> report it. A false alarm is cheaper than silence.
        d = json.loads(out.stdout)
        d = d[0] if isinstance(d, list) else d
        labs = {x if isinstance(x, str) else x.get("name", "") for x in (d.get("labels") or [])}
        return bool(labs & PARK)
    except Exception:
        return False

for p in prs:
    ref = p.get("headRefName") or ""
    if not ref.startswith("devloop/"):
        continue
    if any(l.get("name") == "lane-verified" for l in (p.get("labels") or [])):
        continue
    issue_id = ref[len("devloop/"):]
    if issue_id in held:
        continue
    if parked(issue_id):
        continue
    print("    %s #%s (%s) - open, unlabelled, and no lane holds it" % (repo, p["number"], ref))
' "$_repo" "$PFX" 2>/dev/null)"
  done
fi
if [ -n "$ORPHANS" ]; then
  echo "STUCK: an open PR the lander will never see"
  printf '%s\n' "$ORPHANS" | sed '/^$/d'
  echo "    The lander only reads PRs labelled lane-verified, so these are watched by nothing."
  echo "    SUPERVISOR ACTION - NOT TRIAGE. Finishing one of these means rebasing, pushing and"
  echo "    labelling, and triage may not touch a repository: a branch moved behind a live"
  echo "    lane's back is how two runs end up on one worktree. A triage agent should CONFIRM"
  echo "    the PR is genuinely orphaned and hand it back as an action item, nothing more."
  echo "    For whoever does own it: rebase onto master, get one green run against the pushed"
  echo "    sha, re-read the commit message from git and the body from GitHub, then add"
  echo "    lane-verified. Never label a red or unrebased PR - the label IS the assertion that"
  echo "    it is ready. If it is being held deliberately, park its issue instead and this"
  echo "    check will go quiet."
fi

TRACKER_RC=0
python3 - "$QUIET" "$ROOT" "$PFX" <<'PY' || TRACKER_RC=$?
import json, os, subprocess, sys

quiet = sys.argv[1] == "1"
# The workspace root, passed in rather than hardcoded: the repos hang off it and the
# handed-off check below runs gh inside each one.
ROOT = sys.argv[2]
PFX = sys.argv[3] if len(sys.argv) > 3 else "devloop"
PARK = {"needs-decision", "needs-access", "blocked-tooling", "watch", "umbrella", "roadmap"}

def load(p):
    try: d = json.load(open(p))
    except Exception: return []
    return d if isinstance(d, list) else d.get("issues", [])

allx, op, run = load(f"/tmp/{PFX}-ts-all.json"), load(f"/tmp/{PFX}-ts-open.json"), load(f"/tmp/{PFX}-ts-run.json")
# bd list without --status omits closed, so fetch those separately for the child checks.
try:
    closed = json.load(open(f"/tmp/{PFX}-ts-closed.json"))
    closed = closed if isinstance(closed, list) else closed.get("issues", [])
except Exception:
    closed = []

# allx is a superset of open and in_progress, and it is the only place blocked and deferred
# issues appear. If it does not even cover the two statuses fetched separately, it is short -
# and everything missing is invisible rather than absent, which is the dangerous direction:
# an umbrella whose only live child is blocked reads as finished. Say so and emit NOTHING.
# A scan that reports nothing is a minute lost; a scan that reports confidently from half a
# tracker costs an agent run and can close an epic that still has work in it.
missing = ({i["id"] for i in op} | {i["id"] for i in run}) - {i["id"] for i in allx}
if missing or (not allx and (op or run or closed)):
    print("SCAN ABORTED - the full issue list came back short, so blocked and deferred issues")
    print("are missing and every umbrella holding one would read as finished.")
    print(f"  full list: {len(allx)}  open: {len(op)}  in_progress: {len(run)}  closed: {len(closed)}")
    if missing:
        print(f"  absent from the full list: {' '.join(sorted(missing)[:8])}")
    print("Re-run it. If this repeats, bd itself is failing and that is the thing to fix.")
    sys.exit(2)

universe = {i["id"]: i for i in allx + closed + op + run}

def text(i): return ((i.get("description") or "") + "\n" + (i.get("notes") or "")).lower()

def _lines(raw):
    # (offset, line) so a marker's position can be compared against the question's position.
    # Offsets are into the notes alone, which is where both are written.
    off = 0
    for line in raw.split("\n"):
        yield off, line
        off += len(line) + 1
def labs(i): return set(i.get("labels") or [])

HANDBACK = ("handed back for a person", "handed back", "needs a product decision",
            "this needs a decision", "a product call, not", "not an implementation")
# STRUCTURED markers only, and anchored to the start of a line.
#
# The first version matched the bare words "decided" and "answered" anywhere in the text and
# reported thirteen issues, nearly all of them prose - "once these are answered", "the figures
# decided above". A scan that always fires is a scan nobody reads, and it defeats the whole
# point of only paying for an agent when there is something to do.
#
# These are the markers the pipeline and the owner actually write when recording an answer,
# in the shouted form they are always written in.
# Words that open a note recording that the parking question has been SETTLED. They are matched
# only at the start of a line and only when capitalised, so ordinary prose using the same word
# does not count - a decision somebody meant to record is written as a heading.
#
# "relabelled", "dispatched" and "hold lifted" were added 2026-08-24. Category F kept re-raising
# app-8is1 over the phrase "belongs to a person", written by a lane on 2026-08-23 and answered
# the next day by a supervisor note beginning "RELABELLED 2026-08-24: needs-access removed".
# That IS the answer - relabelling is the act of resolving a parking question - but none of the
# original six markers recognised it, so every later edit to the ticket re-surfaced a settled
# finding. The same applies to a note that records the issue being sent to a lane: you do not
# dispatch something you still believe only a person can do.
ANSWER   = ("decided ", "decided:", "unblocked ", "unblocked,", "unparked ", "answered ",
            "relabelled", "dispatched ", "hold lifted", "retracted from")
RETRACT  = ("correction", "retracted ", "retraction", "withdrawn ", "i was wrong")
EXCLUDE  = ("stays with a person", "never unattended", "only you can", "a person must choose",
            "under the exclusion", "belongs to a person",
            # Added 2026-08-23 after four tickets in one day named their own open questions in
            # prose, carried no label, and were each dispatched to a lane that spent ~100k
            # tokens rediscovering what the ticket already said. One of them was app-1jxg.9.3.1,
            # which had already burned 621k tokens and had its PR closed unmerged.
            #
            # Each phrase below is taken verbatim from one of those tickets, and they are long
            # on purpose. The first version of this list matched bare words and reported thirteen
            # issues, nearly all prose; the cost of a miss is one wasted lane, the cost of a
            # scan nobody reads is every lane. Prefer a phrase somebody had to choose to write.
            "for a person to choose", "for a person to decide", "a person picks",
            "not a scoped task", "is not to build it", "the question, not the code",
            "before anything is edited", "worth weighing before",
            # Two more from app-fave.6.2 on 2026-08-23, which said both of these in its opening
            # lines and was still offered as ordinary work.
            "as a decision rather than a task", "yes or no from a person")
# The owner has cleared this label, deliberately, and said so in the notes.
#
# An issue can go on describing itself as needing a person long after that stopped being true -
# the description is written once, the decision arrives later. app-i6yt says "stays with a person"
# in its opening line and the owner has now cleared its label twice, with reasons. Category F
# would flag it forever, and every agent reading the flag is one step from re-parking it, which
# is the thing the owner objected to.
#
# So a recorded clearing wins over the ticket's own prose. This is the structural half of the
# rule in TRIAGE.md; the written rule alone was not enough, because the scan kept raising it.
OWNER_CLEARED = ("removing it again", "removing again", "label re-applied after being cleared",
                 "was cleared on", "cleared by the owner", "unparked", "left unlabelled")

findings = []
# id -> "closed/total" for every umbrella examined, for the watermark. See watermark().
child_fp = {}

for i in op:
    l, t = labs(i), text(i)
    parked = l & PARK

    owner_cleared = any(m in t for m in OWNER_CLEARED)

    # A - the text says somebody was asked, no label says so
    if not parked and not owner_cleared:
        hb = max((t.rfind(p) for p in HANDBACK), default=-1)
        an = max((t.rfind(p) for p in ANSWER), default=-1)
        if hb >= 0 and an < hb:
            findings.append(("A unlabelled hand-back", i, "its text says it was handed back; no label parks it"))

    # F - the text excludes itself from unattended work, no label says so
    #
    # An exclusion can be ANSWERED, and then it is history rather than a live constraint.
    # app-7iif.3 said "a person must choose the mechanism"; a person chose, the answer was written
    # underneath, and category F went on flagging the sentence that asked. Category B has always
    # compared positions for exactly this reason - a marker that comes AFTER the question settles
    # it - and F was never given the same treatment.
    if not parked and not owner_cleared:
        ex = max((t.rfind(p) for p in EXCLUDE), default=-1)
        raw_f = (i.get("notes") or "")
        answered_after = -1
        for ln_start, line in _lines(raw_f):
            low = line.lstrip().lower()
            if any(low.startswith(m) for m in ANSWER) and line[:1].isupper():
                answered_after = max(answered_after, ln_start)
        # positions are into different strings, so compare on the notes alone: if the notes
        # carry a decision at all AND the exclusion phrase also appears in the notes, the
        # decision has to come later to count.
        ex_in_notes = max((raw_f.lower().rfind(p) for p in EXCLUDE), default=-1)
        if answered_after >= 0 and answered_after > ex_in_notes:
            ex = -1
        if ex >= 0:
            findings.append(("F unlabelled exclusion", i, "its text excludes it from unattended work; no label parks it"))

    # B - parked, but an answer was recorded after the question
    #
    # ONLY needs-decision. B asks "was the question answered and the label left behind?", and
    # that only makes sense for a label that represents a QUESTION. The other parking labels
    # are not questions and no answer resolves them: needs-access wants somebody to run a
    # command, open a dashboard or hold a device; blocked-tooling wants a gap in this pipeline
    # closed; watch wants time to pass. An issue can be fully decided and still be every bit as
    # blocked by those.
    #
    # It fired on app-8is1 for exactly that reason on 2026-08-23 - the product question was
    # answered and recorded, the code was written and green, and the only thing left was the
    # owner running --acknowledge on the manifest guard. Removing its label would have handed a
    # lane an issue no lane can finish.
    if "needs-decision" in parked:
        raw = (i.get("notes") or "")
        hb = max((t.rfind(p) for p in HANDBACK), default=-1)
        an = -1
        for ln_start, line in _lines(raw):
            low = line.lstrip().lower()
            if any(low.startswith(m) for m in ANSWER) and line[:1].isupper():
                an = max(an, ln_start)
        # An answer can be WITHDRAWN, and the note withdrawing it is the newest thing on the
        # ticket. Scanned the same way as ANSWER - start of a line, shouted - so ordinary prose
        # like "that was wrong" mid-paragraph does not count. app-tuug.2 on 2026-08-24 carried an
        # UNPARKED note and then a CORRECTION note retracting it; without this, B read the
        # retracted answer as current and would have handed a lane an instruction whose own
        # author had withdrawn it - one that would have double-charged customers.
        re_ = -1
        for ln_start, line in _lines(raw):
            low = line.lstrip().lower()
            if any(low.startswith(m) for m in RETRACT) and line[:1].isupper():
                re_ = max(re_, ln_start)
        if an > hb and an >= 0 and re_ < an:
            findings.append(("B answered but parked", i, "an answer is recorded after the question; the label was never removed"))

    # C and D - umbrella bookkeeping
    if "umbrella" in l:
        # CHILDREN ARE NOT ALWAYS DOTTED, and assuming they are is dangerous.
        #
        # bd exposes no parent field in --json, so the only structural signal is the id
        # convention: sr-x.1 is a child of sr-x. That convention is not universal. app-v2fr's
        # children are app-pw2s, app-i6yt and app-am7p - created before the convention settled -
        # and an id-prefix scan calls it childless. Acting on that would have removed the
        # umbrella label from a P1 payment epic and dropped it straight into the ready queue.
        #
        # So also look for the phrase the split agent writes into every child it creates:
        # "Split from <parent-id>". Between the two, a genuinely childless umbrella is rare
        # and worth looking at; a false positive here is worse than a miss.
        depth = i["id"].count(".")
        kids = [k for k in universe.values()
                if k["id"].startswith(i["id"] + ".") and k["id"].count(".") == depth + 1]
        if not kids:
            marker = "split from " + i["id"]
            kids = [k for k in universe.values()
                    if k["id"] != i["id"] and marker in text(k)]
        # Recorded for the watermark below, whether or not a finding fires. An umbrella's
        # judgement depends on its CHILDREN, and nothing about the children appears on the
        # umbrella itself - see the note on watermark().
        child_fp[i["id"]] = "%d/%d" % (sum(1 for k in kids if k.get("status") == "closed"), len(kids))
        # AND THE LABEL MAY NEVER HAVE BEEN APPLIED BY ANYBODY. `bd create --parent` INHERITS
        # the parent's labels - confirmed with `bd create --parent <umbrella-id> --dry-run
        # --json`, which returns labels ["umbrella"] on a brand new issue nobody has touched.
        # So every child of an umbrella epic is BORN umbrella'd, and a leaf that was never
        # meant to be a parent looks exactly like an umbrella somebody forgot to fill in.
        #
        # This fired three times on 2026-08-25 - app-w23d.12, app-w23d.13, and .13's own freshly
        # created children - each costing a triage agent to establish that nothing was wrong.
        # The paragraph above already says a false positive here is worse than a miss, and an
        # inherited label is a false positive by construction: it is evidence about the
        # PARENT's shape, not about this issue.
        #
        # So when the immediate parent is itself an umbrella, stay quiet. A genuine childless
        # umbrella nested under another umbrella is missed, which is the trade this check
        # already says it wants.
        parent_id = i["id"].rsplit(".", 1)[0] if depth else None
        inherited = bool(parent_id
                         and parent_id in universe
                         and "umbrella" in (universe[parent_id].get("labels") or []))
        if not kids and not inherited:
            findings.append(("C umbrella with no children", i, "no children found by id or by a 'Split from' marker - CHECK for non-dotted children before removing the label"))
        elif kids and all(k.get("status") == "closed" for k in kids):
            findings.append(("D umbrella, all children closed", i, f"all {len(kids)} children are closed; this can close"))

# E - claimed but nothing is running it
#
# A MISSING WORKTREE IS NOT DEATH, and the first version of this check did not know that.
# The ship step removes the worktree BEFORE merging, so that --delete-branch does not fail on
# a checked-out branch. Every healthy lane therefore looks exactly like a stale claim for the
# whole merge-verify-deploy-close window, which is minutes. This fired on app-ltw9 and app-l6fy,
# both of which were mid-merge and finished normally.
#
# So ask the harness instead. A workflow's task output file is created empty at dispatch and
# written when it finishes: still empty means still running. If any live run mentions this
# issue, it is not stale, whatever the worktree says.
def _slug():
    """The harness names its per-project directory after the workspace path with the
    separators swapped. Computed, never named: pinned to one project's absolute path this
    reported another workspace's runs as though they were the caller's."""
    return os.environ.get("DEVLOOP_ROOT", ROOT).replace("/", "-")

def _tasks_dir():
    import glob
    hits = sorted(glob.glob("/private/tmp/claude-*/" + _slug() + "/*/tasks"),
                  key=os.path.getmtime, reverse=True)
    return hits[0] if hits else ""

TASKS = _tasks_dir()
WFDIR = os.path.expanduser("~/.claude/projects/" + _slug())

def _live_ids():
    """Issue ids named by a workflow whose result has not been written yet."""
    ids = set()
    try:
        recent = [d for d in os.listdir(WFDIR)
                  if os.path.getmtime(os.path.join(WFDIR, d)) > (__import__("time").time() - 3600)]
    except Exception:
        return ids
    for d in recent:
        path = os.path.join(WFDIR, d)
        try:
            out = subprocess.run(["grep", "-rhoam1", "-E", r"sr-[a-z0-9]+(\.[0-9]+)*", path],
                                 capture_output=True, text=True, timeout=20).stdout
        except Exception:
            continue
        for line in out.splitlines():
            ids.add(line.strip())
    return ids

# HANDED OFF IS NOT DEAD, and since 2026-08-23 it looks exactly like it.
#
# A lane no longer merges its own work: it gets the PR green, labels it lane-verified, REMOVES
# ITS WORKTREE so the lander's --delete-branch will not trip, leaves the issue in_progress, and
# ends. So every successful lane now ends in the precise shape category E was written to catch -
# in_progress, no worktree, no live run - and E fired on app-prnu.1 and app-zcfk within minutes of
# both handing off perfectly. Twelve issues were in that state at once; each false finding costs
# an agent run to rule out.
#
# The label is the difference, and it is authoritative: nothing writes lane-verified except a
# lane that finished. If a PR carries it, the work is waiting for the lander, not lost.
# Open pull requests that carry the label, as (repo, number). Filled by _handed_off_ids below.
# A branch name is not always devloop/<id> - a pull request opened by hand carries whatever the
# person called it - so the id-from-branch mapping misses those entirely and category E then
# reports a finished hand-off as a dead lane.
queued_prs = set()

def _handed_off_ids():
    ids = set()
    for repo in ("site", "extension", "integration", "docs"):
        path = os.path.join(ROOT, repo)
        if not os.path.isdir(path):
            continue
        # TWO STATES, NOT ONE. A labelled open PR is waiting for the lander; a MERGED one has
        # already landed and is waiting only for the deploy that closes its issue. Both leave the
        # issue in_progress with no worktree, which is indistinguishable from a dead lane.
        #
        # Only the first was asked about here, so every issue the lander merged came back as
        # "E stale claim - a lane probably died holding it" about an hour after it landed.
        # app-j6zh and app-ddvx were both reported that way on 2026-08-24 while their PRs, #410 and
        # #399, were merged and green. Acting on that finding means reopening shipped work and
        # handing it to a lane to write again.
        #
        # The notes-marker guard further down was the previous defence and it does not cover
        # this: it only fires when a LANE wrote "merged but not live" into the issue, and a PR
        # the LANDER merged has no such note - nothing writes one until the deploy.
        # The open labelled set is asked for twice: once for branch names, once for numbers, so a
        # pull request whose branch says nothing about its issue can still be recognised from the
        # issue's own notes. app-sxix was exactly that - branch "product-hunt-badge", labelled and
        # queued, and its issue quoted the number.
        try:
            nums = subprocess.run(
                ["gh", "pr", "list", "--state", "open", "--label", "lane-verified",
                 "--json", "number", "--jq", ".[].number"],
                cwd=path, capture_output=True, text=True, timeout=30).stdout
            for n in nums.split():
                if n.isdigit():
                    queued_prs.add((name, int(n)))
        except Exception:
            pass

        for args in (["--state", "open", "--label", "lane-verified"],
                     ["--state", "merged", "--limit", "60"]):
            try:
                out = subprocess.run(
                    ["gh", "pr", "list", *args, "--json", "headRefName", "--jq", ".[].headRefName"],
                    cwd=path, capture_output=True, text=True, timeout=30).stdout
            except Exception:
                continue   # cannot ask: fall through and let E flag it, a false finding beats a miss
            for line in out.splitlines():
                branch = line.strip()
                if not branch.startswith("devloop/"):
                    continue
                bid = branch[len("devloop/"):]
                ids.add(bid)
                # Branches are not always exactly devloop/<id>: a lane that reworks its own
                # branch appends a word, as devloop/app-1jxg.9.3.1-parse did. Matching only the
                # exact name missed that PR entirely and its issue read as a dead lane.
                # Stop before the prefix itself. Stripping unconditionally turns app-g02p.1 into
                # the bare "sr", which is not an id and matches nothing, but is exactly the kind
                # of junk that later reads as a real entry to somebody debugging this set.
                while "-" in bid:
                    cand = bid.rsplit("-", 1)[0]
                    if "-" not in cand:
                        break
                    bid = cand
                    ids.add(bid)
    return ids

handed_off = None
live_ids = None
for i in run:
    wt = f"/private/tmp/{PFX}-worktrees/" + i["id"]
    if os.path.isdir(wt):
        # G - THE WORKTREE IS THERE AND NOBODY IS TOUCHING IT.
        #
        # Category E below only ever asked about a MISSING worktree, so a lane that died while
        # still holding one was invisible to this scan entirely. That is not a harmless gap: the
        # lane opens its PR during Fix and only labels it lane-verified at Handoff, so a death in
        # between leaves an open, unlabelled PR that the lander never sees, an issue stuck
        # in_progress, and a slot that queue.sh still counts as busy. Nothing else notices, and
        # the work simply stops existing as far as the pipeline is concerned.
        #
        # -mmin, never -newermt "-30 minutes": on BSD find the latter matches NOTHING silently,
        # which once had a live lane declared dead and its migration deleted underneath it.
        try:
            touched = subprocess.run(["find", wt, "-mmin", "-30"],
                                     capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception:
            touched = "x"   # cannot tell - assume alive, a false death costs more than a miss
        if touched:
            continue
        if live_ids is None:
            live_ids = _live_ids()
        if i["id"] in live_ids:
            continue
        findings.append(("G lane died holding its worktree", i,
                         f"in_progress, {wt} untouched for 30+ min, no live run names it - "
                         "check for an open unlabelled PR the lander will never see"))
        continue
    if handed_off is None:
        handed_off = _handed_off_ids()

    # An issue whose notes quote a pull request number that is open and labelled is handed off,
    # whatever its branch was called. Checked against the numbers actually queued rather than any
    # number in the text, so an unrelated "#12" cannot silence a real finding.
    _n = (i.get("notes") or "")
    if any(f"#{num}" in _n or f"/pull/{num}" in _n for _repo, num in queued_prs):
        continue

    if i["id"] in handed_off:
        continue   # green, labelled, queued for the lander - finished, not dead
    if live_ids is None:
        live_ids = _live_ids()
    if i["id"] in live_ids:
        continue   # a run is still going; the worktree is gone because it is mid-merge
    # MERGED-BUT-NOT-DEPLOYED IS NOT A DEAD LANE, and it looks exactly like one: no worktree,
    # no live run, still in_progress. The difference is that the work LANDED and the issue was
    # held open deliberately, because a merge that is not live is not done - which is what a
    # lane does when it cannot deploy, usually because the main checkout is on somebody's
    # branch. Three issues were in that state at once on 2026-08-21 (app-xmgr, app-1jxg.10.1,
    # app-wkl1.4.2) and reopening any of them would have thrown away a completed merge's status.
    #
    # A lane that dies mid-flight leaves no merge record. One that merged and could not deploy
    # says so in its notes, with the commit.
    notes_l = (i.get("notes") or "").lower()
    if any(m in notes_l for m in ("mergecommit", "merge commit", "squashed to master",
                                  "squash-merged", "state merged", "merged but not live",
                                  "deploy is the outstanding item")):
        continue
    findings.append(("E stale claim", i, "in_progress, no worktree, and no live run names it - a lane probably died holding it"))

# ONLY REPORT WHAT IS NEW OR HAS CHANGED SINCE IT WAS LAST TRIAGED.
#
# Without this the scan reports the same eighteen issues every fifteen minutes forever, an
# agent is spawned every time to re-read them, and the cost is the same as having no trigger
# at all. Worse, a report that never changes is one nobody reads.
#
# The watermark is a hash of the parts a triage would act on - the labels and the notes. If a
# person answers a question, or a lane appends a finding, the hash moves and the issue comes
# back. If nothing has changed, the last judgement still stands and there is nothing to redo.
#
# Delete /tmp is not where this lives: losing it means one noisy run, not lost work.
SEEN = os.path.expanduser("~/.claude/skills/devloop/.triage-seen.json")
try:
    seen = json.load(open(SEEN))
except Exception:
    seen = {}

import hashlib
def watermark(i):
    # THE CHILD COUNT IS PART OF THE JUDGEMENT, so it has to be part of the hash.
    #
    # Labels and notes alone were not enough, and the gap was not theoretical: app-c0g6 was
    # triaged on 2026-08-23 and correctly left open, because one child was still open. When
    # that child closed, the umbrella became closeable - but nothing on the umbrella changed,
    # so the hash still matched and the scan carried it silently for a day. Category D fires
    # on a condition the watermark could not see, which is the one combination that produces
    # a permanent blind spot rather than a delay.
    #
    # An issue with no children contributes an empty string, so nothing else is disturbed.
    blob = (",".join(sorted(labs(i))) + "|" + (i.get("notes") or "")
            + "|" + child_fp.get(i["id"], ""))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]

fresh, carried = [], 0
for f in findings:
    kind, i, why = f
    wm = watermark(i)
    if seen.get(i["id"]) == wm:
        carried += 1
        continue
    fresh.append(f)

if os.environ.get("TRIAGE_MARK") == "1":
    for kind, i, why in findings:
        seen[i["id"]] = watermark(i)
    os.makedirs(os.path.dirname(SEEN), exist_ok=True)
    json.dump(seen, open(SEEN, "w"), indent=0, sort_keys=True)

findings = fresh

if not findings:
    if not quiet:
        print(f"CLEAN - nothing stuck that has not already been triaged ({carried} carried)")
    sys.exit(0)

print(f"STUCK: {len(findings)} finding(s)\n")
for kind, i, why in sorted(findings, key=lambda f: (f[0], i.get("priority", 9))):
    print(f"[{kind}] {i['id']} P{i.get('priority')} - {i['title'][:56]}")
    print(f"    {why}")
sys.exit(1)
PY

# ---------------------------------------------------------------------------------------------
# H  LANDER IDLE - labelled pull requests waiting with nothing landing them.
#
# Everything above watches the TRACKER. This watches the MERGE QUEUE, which is a different
# failure and the more expensive one: a lane can finish, label its PR and close its own loop
# while the change never reaches master, and no tracker field changes when that happens.
#
# It is not hypothetical. On 2026-08-24 merges landed at 12 and 27 minutes ago and the queue was
# still eleven deep, with hour-long holes behind it - land.js drains at most MAX_ROUNDS rounds
# and then EXITS, and nothing relaunches it. Every hole in the merge history is a stretch where
# no lander was running and nobody noticed, because the tracker looked busy the whole time.
#
# Reported under its own marker rather than STUCK. STUCK means "an agent should read tickets and
# decide"; this one means "relaunch land.js", which only the session holding the Workflow tool
# can do. Sending it to a triage agent would spend a run on something it cannot fix.
#
# The merge lock is the liveness signal. The lander takes it at the start of a run and drops it
# at the end, so its presence means a run is in flight and its absence means none is. A lander
# killed mid-run leaves the lock behind, which is why age is checked too: no single lander round
# has ever taken an hour, so a lock older than that is residue rather than work.
LANDER_RC=0
python3 - "$QUIET" "$CFG" "$PFX" "$ROOT" <<'PY' || LANDER_RC=$?
import json, os, subprocess, sys, time

quiet   = sys.argv[1] == "1"
cfg_sh  = sys.argv[2]
pfx     = sys.argv[3]
# config.sh discovers .autofix.json by walking UP from its own working directory, so it must be
# run from inside the workspace. Inheriting this process's cwd works only for as long as the
# caller happens to be there; the root is already known here, so pass it.
wsroot  = sys.argv[4]
LOCK    = f"/tmp/{pfx}-merge.lock"

try:
    cfg = json.loads(subprocess.run(["bash", cfg_sh], cwd=wsroot, capture_output=True, text=True, timeout=20).stdout)
except Exception as e:
    # NOT a silent exit. An unreadable config and an empty queue are indistinguishable downstream,
    # and one of them means this check is not running at all.
    print(f"LANDER UNKNOWN: cannot read {cfg_sh} ({e}) - the merge queue was NOT checked.")
    sys.exit(1)

root  = cfg.get("root") or ""
repos = cfg.get("repos") or {}

# gh infers the repository from the checkout, so no slug table is needed here and none can go
# stale. Read-only: `gh pr list` never touches the working tree, which matters because these are
# the owner's own checkouts and may sit on a branch with uncommitted work.
waiting, unreachable, checked = [], [], 0
for name, r in repos.items():
    if isinstance(r, dict) and r.get("noLander"):
        continue
    path = os.path.join(root, r.get("path", name)) if isinstance(r, dict) else os.path.join(root, name)
    if not os.path.isdir(os.path.join(path, ".git")):
        continue
    checked += 1     # counted BEFORE the call, so a raised timeout counts as attempted too -
                     # otherwise an all-timeout sweep has checked == 0 and the guard below cannot fire
    try:
        out = subprocess.run(
            ["gh", "pr", "list", "--label", "lane-verified", "--state", "open", "--json", "number"],
            cwd=path, capture_output=True, text=True, timeout=45)
        if out.returncode != 0:
            unreachable.append(name)
            continue
        waiting += [(name, p["number"]) for p in json.loads(out.stdout or "[]")]
    except Exception:
        unreachable.append(name)

# Every repository failing is not an empty queue, it is a broken check - no gh auth, no network,
# or a config pointing at directories that are not checkouts any more. Say so rather than
# printing nothing, which is what "the queue is clear" looks like.
if unreachable and len(unreachable) == checked:
    print(f"LANDER UNKNOWN: gh could not list pull requests in any repository "
          f"({', '.join(unreachable)}) - the merge queue was NOT checked.")
    sys.exit(1)

# UNLABELLED OPEN PULL REQUESTS ARE WHERE FINISHED WORK GOES TO BE FORGOTTEN.
#
# Everything else here reads the tracker or reads labels. Neither can see a pull request that is
# green, complete, and carries no lane-verified label - the lander never surveys it because that
# label is its whole interface, and no scan looks at it because its issue is closed.
#
# Three sat that way for seventy hours: extension #78 and #79 and integration #11, all green,
# two of them with their tracker issue already closed and its close reason describing the work as
# done. They were found by listing open pull requests by hand, which is not a thing that happens
# on a schedule.
#
# Reported, never acted on: an old unlabelled pull request is sometimes deliberate - a draft, a
# spike, somebody's half-finished thought - so this says what it sees and lets a person judge.
stale_unlabelled = []
for name, r in repos.items():
    path = os.path.join(root, r.get("path", name)) if isinstance(r, dict) else os.path.join(root, name)
    if not os.path.isdir(os.path.join(path, ".git")):
        continue
    try:
        out = subprocess.run(
            ["gh", "pr", "list", "--state", "open", "--json", "number,title,labels,createdAt"],
            cwd=path, capture_output=True, text=True, timeout=45)
        if out.returncode != 0:
            continue
        import datetime as _dt
        now = _dt.datetime.now(_dt.timezone.utc)
        for pr in json.loads(out.stdout or "[]"):
            if any(l.get("name") == "lane-verified" for l in (pr.get("labels") or [])):
                continue
            try:
                age = (now - _dt.datetime.fromisoformat(pr["createdAt"].replace("Z", "+00:00"))).total_seconds() / 3600
            except Exception:
                continue
            if age >= 24:
                stale_unlabelled.append((name, pr["number"], int(age), pr.get("title", "")[:46]))
    except Exception:
        continue

if stale_unlabelled and not quiet:
    print(f"UNLABELLED PRs OPEN OVER A DAY: {len(stale_unlabelled)} - finished work is invisible "
          f"to the lander without the label, so check whether these are done or deliberate.")
    for name, num, age, title in sorted(stale_unlabelled, key=lambda x: -x[2]):
        print(f"    {name}#{num}  {age}h  {title}")

if not waiting:
    if unreachable and not quiet:
        print(f"note: no labelled PRs found, but {', '.join(unreachable)} could not be listed")
    sys.exit(0)

held  = os.path.isdir(LOCK)
holder = ""
age_min = None
if held:
    try:
        holder = open(os.path.join(LOCK, "holder")).read().strip()
    except Exception:
        pass
    try:
        age_min = int((time.time() - os.path.getmtime(os.path.join(LOCK, "holder"))) / 60)
    except Exception:
        age_min = None

listing = " ".join(f"{r}#{n}" for r, n in waiting[:12]) + (" ..." if len(waiting) > 12 else "")

if not held:
    print(f"LANDER IDLE: {len(waiting)} labelled PR(s) waiting and no lander holding the merge lock.")
    print(f"    {listing}")
    print("    Relaunch it - this session only, a triage agent cannot: "
          "Workflow({scriptPath: '~/.claude/skills/devloop/land.js'})")
    sys.exit(1)

# AGE ALONE IS NOT EVIDENCE OF DEATH, and this said it was.
#
# The first version called a stall at sixty minutes flat. A perfectly healthy run tripped it at
# sixty-eight - it had merged two pull requests inside that window and was mid-conflict on a
# third - and the finding it printed ended with the command to remove the lock. Clearing a live
# lander's lock is precisely the accident every other guard in this file exists to prevent, and
# a triage agent had to reason its way out of the advice by hand.
#
# So ask for proof of life before crying stall: a merge landing AFTER the lock was taken can
# only have come from the process holding it. Age is then the fallback for the case where
# nothing has landed at all, and the threshold has room for one slow conflict analysis.
lock_ts = 0
try:
    lock_ts = os.path.getmtime(os.path.join(LOCK, "holder"))
except Exception:
    pass

merged_since = False
for name, r in repos.items():
    path = os.path.join(root, r.get("path", name)) if isinstance(r, dict) else os.path.join(root, name)
    if not os.path.isdir(os.path.join(path, ".git")):
        continue
    try:
        # --limit is applied to a list ordered by CREATION, not by merge time, so a small limit
        # returns the five newest pull requests that happen to be merged - not the five most
        # recently merged. With limit 5 the lander's own last two merges were invisible and a
        # live run read as "nothing merged yet". Ask for a wide window and take the maximum.
        out = subprocess.run(
            ["gh", "pr", "list", "--state", "merged", "--limit", "60", "--json", "mergedAt",
             "--jq", ".[].mergedAt"],
            cwd=path, capture_output=True, text=True, timeout=45)
        for line in out.stdout.splitlines():
            t = line.strip().replace("Z", "+0000")
            if not t:
                continue
            import datetime
            try:
                when = datetime.datetime.strptime(t, "%Y-%m-%dT%H:%M:%S%z").timestamp()
            except ValueError:
                continue
            if when > lock_ts:
                merged_since = True
                break
    except Exception:
        merged_since = True   # cannot tell: assume alive. A false stall costs a live lander.
    if merged_since:
        break

if age_min is not None and age_min > 90 and not merged_since:
    print(f"LANDER STALL?: merge lock held by '{holder or 'unknown'}' for {age_min} minutes "
          f"with {len(waiting)} PR(s) still labelled, and nothing has merged since it was taken.")
    print(f"    {listing}")
    print("    That is the combination that means dead rather than slow. CONFIRM it before "
          "acting - `live.sh` lists runs whose result is not yet written, and a lander started "
          "within a minute of the lock is the one holding it. Only if no such run exists: "
          f"`rmdir {LOCK}/holder` then `rmdir {LOCK}`, and relaunch land.js.")
    sys.exit(1)

if not quiet:
    print(f"LANDER RUNNING: '{holder or 'unknown'}' holds the merge lock"
          + (f" ({age_min}m" if age_min is not None else "")
          + (", merges landing" if merged_since else ", nothing merged yet") + ")"
          + f", {len(waiting)} PR(s) still queued behind it.")
sys.exit(0)
PY

# Either finding is worth waking somebody for, and they are different problems with
# different fixes - a tracker finding wants an agent to read tickets, a lander finding wants
# this session to relaunch land.js. Both print; the exit code just says "something".
if [ -n "$ORPHANS" ] || [ "$TRACKER_RC" -ne 0 ] || [ "$LANDER_RC" -ne 0 ]; then exit 1; fi

# --- lane occupancy -----------------------------------------------------
# CLEAN means nothing is STUCK. It says nothing about lanes being EMPTY.
# Reporting CLEAN and stopping while lanes sit idle is how the supervisor ends
# up waiting to be asked for work instead of dispatching it.
#
# Counted the way slot.sh counts, and for the same reason: a slot is taken if
# EITHER the registry holds it OR its lane lock exists. Neither alone is
# enough - the registry is written at dispatch and the lock only when the run
# first touches the database, minutes later. And the lock for slot N is
# lane-(N+1), never lane-N; getting that wrong reports a phantom free lane on
# every tick, which is a standing instruction to double-book.
# $0 is whatever the caller typed, so dirname breaks when the script is invoked
# by a relative path from another directory. BASH_SOURCE is the file itself, which
# is what slot.sh uses and why slot.sh gets this right.
_pfx="$PFX"
_lanes="$(bash "$CFG" lanes 2>/dev/null)"
# FALL BACK DOWN, NEVER UP. A config read that fails looks exactly like a config
# that says nothing, and an optimistic fallback turns that into a standing order
# to dispatch past the configured concurrency. 8 was the old fallback and it
# reported 8 lanes on a 6-lane workspace.
case "$_lanes" in ''|*[!0-9]*) _lanes=1 ;; esac
_free=0
for _n in $(seq 1 "$_lanes"); do
  [ -f "/tmp/${_pfx}-slots/$_n" ] && continue
  [ -d "/tmp/${_pfx}-lane-$((_n + 1)).lock" ] && continue
  _free=$((_free + 1))
done
if [ "$_free" -gt 0 ]; then
  echo
  echo "LANES: $_free of $_lanes free -- DISPATCH BEFORE ENDING THE TICK."
  echo "  bd ready, drop park labels (umbrella needs-access needs-decision watch"
  echo "  blocked-tooling roadmap) and ids that already carry a labelled PR, then"
  echo "  slot.sh <id> and launch task.js at the highest-priority remainder."
  echo "  Widening the search is the job; 'nothing that does not collide' is not"
  echo "  a terminal state. TaskList shows what is actually still running - a"
  echo "  scheduled tick cannot run /workflows."
fi

exit 0
