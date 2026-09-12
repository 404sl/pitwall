#!/bin/bash
# State of the devloop queue, in one screen.
#
#   queue.sh            print the summary
#   queue.sh --next 3   print the summary, then claim and print the next 3 issue ids
#
# Reads through the bd CLI. It used to query .beads/beads.db with sqlite3, which stopped
# working at bd 1.0: issues now live in an embedded Dolt database and the JSONL is only a
# passive export. Anything here that wants tracker state must go through bd.
#
# "Running" is the in_progress count: one workflow owns exactly one issue and claims it, so
# that IS the number in flight. It needs no task list and survives a session restart. A
# workflow that dies leaves a stale claim - shown below with the command to release it.
#
# Six labels park an issue. Four say WHO or WHAT it waits on - needs-decision (a choice only
# the owner can make), needs-access (something only they can run: a deploy, a dashboard, a
# device), blocked-tooling (a gap in this pipeline, not a question for anyone), watch (an
# observation over time) - plus umbrella (a parent whose
# work lives in its children) and roadmap (a feature build, not a defect).
#
# A workspace that declares "actor" in its config also gets an assignee gate, matching
# dispatchable.sh: "ready to start" and `--next` then count and claim only the issues assigned
# to that queue, and the line says which queue it counted. Without the field nothing is
# filtered by assignee, which is what every workspace that has never assigned a ticket needs.
#
# The two scripts share the rule because watch.sh builds its DISPATCH line from the number
# printed here - a gate in one and not the other is the second answer to "is this workable"
# that this file exists to avoid.
#
# The field is also the loop's IDENTITY, so `--next` carries it as `bd --actor <name>` on the
# writes it makes. bd resolves its actor from the flag, then BEADS_ACTOR, then git user.name,
# and its ownership guard refuses a claim made under a name that is not the assignee - so a
# gated count with an unstamped claim would print work it then hands out none of.

# ROOT DECIDES WHOSE TRACKER THIS READS, AND WHOSE ISSUES `--next` CLAIMS.
#
# It used to be hardcoded to one workspace while lockPrefix was already being read from the
# config - which is worse than either choice alone, because the script then looked configured
# while silently answering about somebody else's backlog. Run from a second project it printed
# the first project's queue, and `--next` would have set in_progress on the first project's
# issues and launched lanes against the first project's repos. Caught before that happened, by
# a second session noticing the printed backlog was not its own.
#
# Order: DEVLOOP_ROOT wins (an escape hatch that needs no edit), then the config, then the
# historical default so a bare checkout still works.
CFG="$(dirname "${BASH_SOURCE[0]}")/config.sh"
ROOT="${DEVLOOP_ROOT:-$(bash "$CFG" root 2>/dev/null)}"
ROOT="${ROOT:-the workspace root}"

# /tmp is shared across every project on this machine, so the lock paths are namespaced by the
# workspace's lockPrefix rather than fixed. Read it here rather than hardcoding: two projects
# with the same prefix collide on the lane locks, and the lane lock is the only thing stopping
# two lanes from sharing a test database.
PFX="$(bash "$CFG" lockPrefix 2>/dev/null || echo devloop)"
ACTOR="$(bash "$CFG" actor 2>/dev/null)" || ACTOR=""

cd "$ROOT" || exit 1

PARKED="needs-decision needs-access blocked-tooling watch umbrella roadmap"

# A PRIVATE scratch directory per run, not fixed paths under /tmp.
#
# These used to be /tmp/<prefix>-aq-*.json, which two concurrent runs of this script
# share: the supervisor's own tick and anything else asking the same question at the
# same moment overwrite each other's files and then parse the result. It reports
# plausible numbers rather than failing - a run saw "3 ready" while the true answer
# was 11 - and a supervisor under-dispatches on it without ever knowing why. The race
# was always there; watch.sh --loop asking every ninety seconds is what made it show.
AQ="$(mktemp -d "/tmp/${PFX}-aq-XXXXXX")"
trap 'rm -rf "$AQ"' EXIT

bd list --status open --json 2>/dev/null        > "$AQ/open.json"
bd list --status in_progress --json 2>/dev/null > "$AQ/run.json"
bd blocked --json 2>/dev/null                   > "$AQ/blocked.json"
bd list --status closed --json 2>/dev/null      > "$AQ/closed.json"

WANT="${2:-0}"
[ "$1" = "--next" ] || WANT=0

python3 - "$WANT" "$PFX" "$AQ" "$ACTOR" <<'PY'
import json, sys, os, datetime, subprocess

PFX = sys.argv[2] if len(sys.argv) > 2 else "devloop"

PARKED = {"needs-decision", "needs-access", "blocked-tooling", "watch", "umbrella", "roadmap"}

def load(p):
    try:
        d = json.load(open(p))
    except Exception:
        return []
    return d if isinstance(d, list) else d.get("issues", [])

AQ = sys.argv[3] if len(sys.argv) > 3 else f"/tmp/{PFX}-aq"
ACTOR = sys.argv[4] if len(sys.argv) > 4 else ""
BD = ["bd"] + (["--actor", ACTOR] if ACTOR else [])
open_, running, blocked, closed = (load(f"{AQ}/{n}.json") for n in ("open", "run", "blocked", "closed"))
blocked_ids = {i["id"] for i in blocked}

running_ids = {i["id"] for i in running}

# THE TRACKER IS THE ONLY RECORD. There is no side file.
#
# There used to be a park list here, kept outside bd "because labels go missing". They were
# not going missing: needs-feedback comes OFF when the person answers the question, which is
# the label doing exactly its job. The side file then put the issue straight back into
# "waiting on you", so an answered question stayed parked - which is how app-1jxg.3 (already
# done) and app-4f92.1 (a green, mergeable PR) sat idle for hours, and why roughly thirty
# answered decisions were reported back to the owner as still open.
#
# A cache that fights the source of truth is worse than no cache. If an issue needs a person,
# it carries needs-feedback and the reason is in its notes, where whoever picks it up will
# actually read it.

def parked(i):
    return PARKED & set(i.get("labels") or [])

def parent_of(issue_id):
    # app-a8d9.2 -> app-a8d9 ; app-a8d9 -> None
    return issue_id.rsplit(".", 1)[0] if "." in issue_id else None

# Every id that is somebody's parent and still has a child carrying work. Split children keep
# the parent's id as a prefix, so the structure says this whether or not anyone labelled it.
live_children_of = set()
for _i in open_ + running:
    _p = parent_of(_i["id"])
    if _p:
        live_children_of.add(_p)

def eligible(i):
    # A child whose parent is still in flight is not ready, whatever its labels say: the
    # split agent creates children first and labels the decision ones a moment later, so
    # dispatching in that window hands an agent a "Decide whether..." issue that should
    # have been left for a person. Cost of getting this wrong is small - triage bounces it -
    # but it is noise, and it looks like the pipeline attempting work it was told not to.
    if parent_of(i["id"]) in running_ids:
        return False
    # And the mirror of it: a PARENT whose children still hold the work has nothing of its own
    # left to do. Dispatching one means re-implementing a child that has already shipped and
    # attempting one that is blocked. This used to rest entirely on the `umbrella` label, which
    # is written by hand and therefore sometimes is not - app-w6zk had both a closed child and a
    # blocked one, carried no umbrella label, and was dispatched twice on one day for it. The
    # id prefix is the fact; the label is only documentation of it.
    if i["id"] in live_children_of:
        return False
    if ACTOR and (i.get("assignee") or "") != ACTOR:
        return False
    return (i.get("issue_type") != "epic"
            and not parked(i)
            and i["id"] not in blocked_ids)

ready = sorted([i for i in open_ if eligible(i)],
               key=lambda i: (i.get("priority", 9), i.get("created_at", "")))
waiting = sorted([i for i in open_ if parked(i)], key=lambda i: i.get("priority", 9))
today = datetime.date.today().isoformat()
closed_today = [i for i in closed if (i.get("updated_at") or "")[:10] == today]

def hours_since(ts):
    try:
        t = datetime.datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
        now = datetime.datetime.now(t.tzinfo) if t.tzinfo else datetime.datetime.now()
        return int((now - t).total_seconds() // 3600)
    except Exception:
        return 0

bar = "=" * 62
print(bar)
print(f" AUTOFIX QUEUE   {datetime.datetime.now():%Y-%m-%d %H:%M}")
print(bar)
# in_progress STOPPED MEANING "a lane is working on it" on 2026-08-23, when lanes stopped
# merging their own work. A lane now hands off at a labelled PR and leaves the issue
# in_progress for the lander to close after deploy, so in_progress is "claimed and not yet
# live" - which lumps seven working lanes in with twelve finished ones. The supervisor reads
# this number to decide how many more to dispatch, and an inflated one makes it under-dispatch:
# it showed 11 while 7 lanes were actually running.
#
# A working lane has a worktree somebody is writing to. A handed-off one does not - the handoff
# removes it so the lander's --delete-branch will not trip. So ask the disk, and use -mmin,
# never -newermt "-20 minutes", which matches nothing at all on BSD find and would report every
# lane dead.
_working = []
for _i in running:
    _wt = f"/tmp/{PFX}-worktrees/" + _i["id"]
    if not os.path.isdir(_wt):
        continue
    try:
        if subprocess.run(["find", _wt, "-mmin", "-20"],
                          capture_output=True, text=True, timeout=20).stdout.strip():
            _working.append(_i)
    except Exception:
        _working.append(_i)   # cannot tell: count it, so the supervisor errs toward not piling on
_handed_off = len(running) - len(_working)
print(f" running now      {len(_working)}")
if _handed_off:
    print(f" awaiting lander  {_handed_off}  claimed and green, not yet live")
print(f" ready to start   {len(ready)}" + (f"  assigned to {ACTOR}" if ACTOR else ""))

# Report the parked issues BY REASON, never as one total.
#
# This line used to read "waiting on you", counting everything the queue declines to
# dispatch. Most of that is not a question for anybody: an umbrella parent is parked
# because its children carry the work, a roadmap item is parked because it is not for
# now, and the park file is full of scheduling calls the supervisor made. Only the
# needs-feedback ones are actually somebody's decision.
#
# Quoting the combined figure to the person overstated their queue more than fourfold -
# 74 against a real 17 - and they had another session telling them nothing was waiting,
# which was closer to the truth. A number presented as somebody's workload has to be
# only the part that is theirs.
by_reason = {}
for i in waiting:
    for r in sorted(parked(i)):
        by_reason.setdefault(r, []).append(i)
# Report each kind separately. One label meaning four different things produced a count
# that overstated what the owner actually owed - 30 reported when 10 were decisions and 18
# were things only they could RUN. A number is only useful if it means one thing.
LABELS = [
    ("needs-decision",  "a choice only you can make"),
    ("needs-access",    "an action only you can run - deploy, dashboard, device"),
    ("blocked-tooling", "waiting on a tooling fix, not on you"),
    ("watch",           "waiting on observation over time"),
]
for lab, what in LABELS:
    items = by_reason.get(lab, [])
    if items:
        print(f" {lab:<16} {len(items):3}  {what}")
for r, items in sorted(by_reason.items()):
    if r in {l for l, _ in LABELS}:
        continue
    print(f"   parked: {r:<14} {len(items):3}  (not a question)")
print()

if running:
    # HANDED OFF IS NOT STALE, and calling it stale is the expensive direction of wrong.
    #
    # The summary above already separates a lane that is writing to a worktree from one that
    # finished, labelled its pull request and left the issue open for the lander to close after
    # deploy. This listing did not, so every handed-off issue eventually crossed an hour and was
    # printed as "workflow probably died: bd update <id> -s open" - with the command to run.
    # Running it on work that is already green and queued reopens it, the queue offers it again,
    # and a lane redoes from scratch what is sitting in the merge queue finished. Thirteen items
    # were being advertised that way at 15:36 on 2026-08-24, six of them the locale branches.
    #
    # So the same _working set decides the label here. Age still shows, because a genuinely long
    # wait is worth seeing - it just no longer comes with an instruction to throw the work away.
    _working_ids = {i["id"] for i in _working}
    print(" IN FLIGHT")
    for i in sorted(running, key=lambda i: i.get("updated_at", "")):
        h = hours_since(i.get("updated_at"))
        if i["id"] in _working_ids:
            note = f"   <-- STALE {h}h, workflow probably died: bd update {i['id']} -s open" if h >= 1 else ""
        else:
            note = f"   <-- awaiting lander {h}h - green and handed off, do NOT reopen" if h >= 1 else "   <-- handed off"
        print(f"   {i['id']:<10} P{i.get('priority','?')}  {i['title'][:58]}{note}")
    print()

print(" NEXT UP")
for i in ready[:8]:
    print(f"   {i['id']:<10} P{i.get('priority','?')}  {i.get('issue_type',''):<7} {i['title'][:55]}")
if not ready:
    if ACTOR:
        print(f"   (nothing in {ACTOR}'s queue - every open issue is in another queue, needs a "
              "person, is blocked, or is claimed)")
    else:
        print("   (nothing - every open issue needs a person, is blocked, or is claimed)")
print()

if waiting:
    print(" WAITING ON YOU")
    for i in waiting:
        why = ",".join(sorted(parked(i)))
        print(f"   {i['id']:<10} P{i.get('priority','?')}  {i['title'][:48]}  [{why}]")
    print()

print(f" closed today     {len(closed_today)}")
print(bar)

# --next N: claim as we hand each id back, so one issue cannot go to two runs, and hand
# out the SLOT with it. The slot number IS the test database - task.js derives
# TEST_ENV_NUMBER as slot + 1 - so two live workflows given the same slot share one
# database and corrupt each other. Leaving the choice to whoever dispatches made that a
# matter of remembering; assigning it here makes it impossible.
#
# The registry is a directory of files named for the slot, each holding the issue id
# using it. It is reconciled against bd on every run: a slot whose issue is no longer
# in_progress is free, so a died workflow releases its slot the moment its claim is
# released, and nothing has to be cleaned up by hand.
SLOTDIR = f"/tmp/{PFX}-slots"

# Eight, because there are eight parallel test databases: task.js derives TEST_ENV_NUMBER as
# slot + 1, so slot 8 is example_app_test9 and slot 9 would be a database that does not
# exist. Without this cap the assigner happily hands out 9 and the run dies on a missing
# database several minutes in.
MAX_SLOTS = 8

def free_slot(taken):
    n = 1
    while n in taken:
        n += 1
    return n if n <= MAX_SLOTS else None

want = int(sys.argv[1] or 0)
if want > 0:
    os.makedirs(SLOTDIR, exist_ok=True)
    live = {i["id"] for i in running}
    taken = {}
    for name in os.listdir(SLOTDIR):
        if not name.isdigit():
            continue
        path = os.path.join(SLOTDIR, name)
        try:
            holder = open(path).read().strip()
        except OSError:
            continue
        if holder in live:
            taken[int(name)] = holder
        else:
            os.remove(path)

    handed = []
    for i in ready:
        if len(handed) >= want:
            break
        r = subprocess.run(BD + ["update", i["id"], "--claim"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            continue
        slot = free_slot(set(taken))
        if slot is None:
            # Every lane is busy. Give the claim back rather than handing out a lane that is
            # not there - a caller asking for more than there is should be told so.
            subprocess.run(BD + ["update", i["id"], "--status", "open"], capture_output=True, text=True)
            break
        taken[slot] = i["id"]
        with open(os.path.join(SLOTDIR, str(slot)), "w") as f:
            f.write(i["id"])
        handed.append((i["id"], slot))

    for issue_id, slot in handed:
        print(f"{issue_id} {slot}")
PY
