#!/bin/bash

# /tmp is shared across every project on this machine, so the lock paths are namespaced by the
# workspace's lockPrefix rather than fixed. Read it here rather than hardcoding: two projects
# with the same prefix collide on the lane locks, and the lane lock is the only thing stopping
# two lanes from sharing a test database.
#
# RESOLVE IT OR REFUSE. NEVER DEFAULT.
#
# This line used to end `|| echo devloop`, and on 2026-09-08 that wrote a pitwall claim into the
# one workspace registry. The machine lost filesystem access to $HOME/Documents for
# several hours - every path under it returned "Operation not permitted", including .pitwall.json
# - so config.sh could not read the config and this fell back to the default prefix. The write
# itself succeeded, because /tmp was never denied. The other project was then one lane down for a
# claim that was never its own, and the id in it named an issue from a tracker it does not have.
#
# It is the same fault dispatchable.sh and watch.sh were fixed for - a script that cannot tell
# which workspace it is in answering confidently instead of stopping - and it is worse than
# either, because those returned a wrong ANSWER and this performed a WRITE into another
# project's shared state. A wrong answer is read once; a wrong claim sits there.
#
# Two lanes on one slot is exactly what this registry exists to prevent, and the slot number IS
# the test database. Refusing costs a dispatch. Guessing costs two runs.
PFX="$(bash "$(dirname "${BASH_SOURCE[0]}")/config.sh" lockPrefix 2>/dev/null)"
case "$PFX" in
  ''|*[!a-zA-Z0-9_-]*)
    echo "slot.sh: could not resolve lockPrefix from the workspace config - refusing to run." >&2
    echo "         Guessing it would write this project's claims into whichever registry the" >&2
    echo "         default names, which has already happened once and cost another project a lane." >&2
    echo "         Run from the workspace root, and check the config is readable:" >&2
    echo "           bash $(dirname "${BASH_SOURCE[0]}")/config.sh --check" >&2
    exit 3 ;;
esac
# Reserve a lane for an issue dispatched by hand.
#
#   slot.sh app-eeze.1            print a free slot and record it
#   slot.sh --release app-eeze.1  give the lane back
#   slot.sh --list               show who holds what
#
# WHY. queue.sh assigns slots for what IT hands out, but a split's children are dispatched by
# whoever is driving and never reached the registry. Three times in one session that put two
# live runs on one test database. The lane lock caught each of them - but only after a dispatch
# had been spent finding out.
#
# The slot number IS the database: task.js derives TEST_ENV_NUMBER as slot + 1, so slot 3 means
# example_app_test4. Eight of those exist, so there are eight lanes.
#
# THIS FILE IS BOOKKEEPING, NOT SAFETY. The thing that actually stops two runs sharing a
# database is the lane lock task.js takes (mkdir /tmp/${PFX}-lane-N.lock), which is atomic and
# held for the life of the run. This just stops us handing out a number we have already given
# away.
#
# It deliberately does NOT reconcile against bd. That was tried and removed: an issue dispatched
# by hand is not claimed in bd at all, and a query that returns nothing - from a failure, a moved
# tracker, a changed flag - reads identically to "no lanes are busy". The version that did it
# freed every lane while eight were live. A held lane is given back explicitly, or by --gc below,
# which asks the locks rather than the tracker.

SLOTDIR=/tmp/${PFX}-slots

# MAX is the number of test databases that exist; LANES is the concurrency the workspace
# declares. They are not the same number and the difference matters: with six lanes configured
# and eight databases, a registry that has drifted will happily hand out slot 7, which is a lane
# nobody meant to run. That happened on 2026-08-24 - three lanes were live, three registry
# entries were stale leftovers, and two consecutive reservations came back 7 and 8.
#
# So new reservations stop at LANES. The scan of held slots still runs to MAX, because a slot
# handed out before the config was lowered is still real and must not be handed out twice.
MAX=8
LANES="$(bash "$(dirname "${BASH_SOURCE[0]}")/config.sh" lanes 2>/dev/null)"
case "$LANES" in ''|*[!0-9]*) LANES=$MAX ;; esac
[ "$LANES" -gt "$MAX" ] && LANES=$MAX
mkdir -p "$SLOTDIR"

show() {
  for n in $(seq 1 $MAX); do
    [ -f "$SLOTDIR/$n" ] && echo "  slot $n -> $(cat "$SLOTDIR/$n")"
  done
}

case "$1" in
  --list) show; exit 0 ;;
  --release)
    # DROP THE LANE LOCK TOO. A run now gives its own lane and slot back in task.js's finally,
    # through release-lane.sh, whatever way it ends - so this is for a run that never reported at
    # all: killed, crashed, or a supervisor that lost its context. It used to be the only thing
    # that could, and nothing called it, and the next occupant of an unreleased slot is refused
    # with LANE_BUSY on a lock whose owner is long gone.
    #
    # That is not hypothetical: on 2026-08-29 app-vyom ended as a split and left lane-3 held.
    # app-vyom.1 was dispatched into the same slot, found the lock, correctly refused to remove
    # somebody else's lock, and returned having done nothing. app-vyom.2 hit the same wall on
    # lane-4 minutes later. Two dispatches, about 330k tokens, no work.
    #
    # Safe here and nowhere else: --release is called by the supervisor AFTER the run has
    # reported completion, so the lane is definitively finished. --gc must not do this, because
    # it runs against slots whose runs may still be alive.
    [ -z "$2" ] && { echo "usage: slot.sh --release <issue-id>" >&2; exit 2; }
    for n in $(seq 1 $MAX); do
      if [ -f "$SLOTDIR/$n" ] && [ "$(cat "$SLOTDIR/$n")" = "$2" ]; then
        rm -f "$SLOTDIR/$n"
        lock="/tmp/${PFX}-lane-$((n + 1)).lock"
        if [ -d "$lock" ] && rmdir "$lock" 2>/dev/null; then
          echo "released slot $n and lane $((n + 1))"
        else
          echo "released slot $n"
        fi
      fi
    done
    exit 0 ;;
  --gc)
    # A LIVE RUN'S SLOT IS NEVER FREED, and neither the lane lock nor the worktree is a reliable
    # way to know that. Both are late signals: the lock is taken when the run first touches the
    # database, and a lane REMOVES its worktree at handoff while the run itself is still going.
    # So a run that has handed off, or one still designing, looks dead to both checks.
    #
    # It cost a collision on 2026-08-24: slot 1 was freed while app-g02p.4's run was ninety
    # minutes in and had not yet taken lane 2. The slot was handed to another issue, whose run
    # then refused to start because the lane lock appeared underneath it. No database was shared
    # only because that lock check exists - the bookkeeping here was simply wrong.
    #
    # live.sh answers the question directly: it lists the workflow directories with the issue
    # each is working on and when it last wrote anything. A recent write is proof of life that
    # arrives from the moment of dispatch, unlike the other two.
    LIVEOUT="$(bash "$(dirname "${BASH_SOURCE[0]}")/live.sh" 2>/dev/null)"
    # Free any slot whose lane lock is not held.
    #
    # DANGEROUS SOON AFTER A DISPATCH, and the warning is here because it was ignored once: a
    # run takes its lane lock only when it first touches the database, which is several minutes
    # into the work. Before that it is running and looks idle, so this frees its lane and the
    # next dispatch lands on top of it. Two live runs were freed that way within a minute of
    # being started.
    #
    # Use it to clear up after a batch has plainly finished, never as part of refilling.
    # THE WORKTREE IS THE EARLY SIGNAL, and the lane lock is the late one. A run creates its
    # worktree within a minute of starting and takes the lane lock only when it first touches
    # the database, several minutes later. Judging on the lock alone therefore frees every young
    # run, which is what the warning above is about - and knowing that was not enough: it was run
    # out of habit on 2026-08-24 and freed three live lanes at once. Nothing was dispatched into
    # them only because the registry was put back by hand before the next dispatch.
    #
    # So a slot whose worktree has been WRITTEN TO recently is kept, whatever the lock says.
    # -mmin, never -newermt "-N minutes": on BSD find the latter silently matches nothing, which
    # would turn this guard off without any sign that it had.
    for n in $(seq 1 $MAX); do
      [ -f "$SLOTDIR/$n" ] || continue
      held="$(cat "$SLOTDIR/$n")"
      [ -d "/tmp/${PFX}-lane-$((n + 1)).lock" ] && continue
      # A YOUNG RESERVATION IS KEPT WHATEVER ELSE IS TRUE. A dispatched run designs before it
      # cuts a worktree, so for its first stretch it holds NEITHER a lane lock NOR a worktree -
      # invisible to both checks below and freed by both. That is not a hypothetical either: the
      # worktree guard was added on 2026-08-24 and immediately freed a lane dispatched fifteen
      # minutes earlier that was still in its design phase.
      #
      # The registry entry's own mtime is the one signal that exists from the instant of
      # dispatch, so it is checked first and it wins.
      if [ -n "$(find "$SLOTDIR/$n" -mmin -30 2>/dev/null)" ]; then
        echo "keeping slot $n ($held): reserved in the last 30 minutes, too young to judge"
        continue
      fi
      RUNNING="$(bash "$(dirname "${BASH_SOURCE[0]}")/lane-running.sh" --quiet "$held" 2>/dev/null)"
      case "$?" in
        1) ;;
        0) echo "keeping slot $n ($held): a task for it is in flight, its result is not written"; continue ;;
        *) echo "keeping slot $n ($held): ${RUNNING:-UNKNOWN} - cannot establish whether its lane is running"; continue ;;
      esac
      # Wrote something in the last forty minutes -> alive, whatever the lock and worktree say.
      # Forty rather than ten because a lane waiting on a CI run writes nothing while it waits.
      if [ -n "$LIVEOUT" ] && echo "$LIVEOUT" | awk -v id="$held" '
            $2 == id && match($0, /last write [0-9]+min/) {
              m = substr($0, RSTART + 11); sub(/min.*/, "", m); if (m + 0 < 40) found = 1
            }
            END { exit(found ? 0 : 1) }'; then
        echo "keeping slot $n ($held): its run wrote something in the last 40 minutes"
        continue
      fi
      wt="/tmp/${PFX}-worktrees/$held"
      if [ -d "$wt" ] && [ -n "$(find "$wt" -mmin -25 2>/dev/null | head -1)" ]; then
        echo "keeping slot $n ($held): no lane lock yet, but its worktree is being written to"
        continue
      fi
      echo "freeing slot $n (held by $held, no lane lock and no active worktree)"
      rm -f "$SLOTDIR/$n"
    done
    exit 0 ;;
esac

ID="$1"
[ -z "$ID" ] && { echo "usage: slot.sh <issue-id> | --release <id> | --list | --gc" >&2; exit 2; }

# A PARKED ISSUE IS NOT DISPATCHABLE, and this is the moment to say so.
#
# A lane meeting needs-decision, needs-access, roadmap or blocked-tooling bounces without doing
# anything - the label is a gate and that is what it is for. The waste is upstream: a slot is
# reserved, a workflow starts, several minutes go by, and the answer is "this is parked".
#
# It happened three times on 2026-08-25 alone - app-zsk0.1, app-mjod, app-6ef6 - and every time the
# same way round: a lane bounced an issue and labelled it, the question was answered within the
# hour, and the issue was re-dispatched with the label still on. Answering a question is not
# finishing it while the label still says otherwise.
#
# So refuse here, and name the label. If the question really is answered, take the label off
# first; that is one command and it leaves the tracker honest.
if [ -n "$ID" ] && command -v bd >/dev/null 2>&1; then
  parked="$(bd show "$ID" --json 2>/dev/null | python3 -c '
import json, sys
try:
    i = json.load(sys.stdin)
except Exception:
    sys.exit(0)
i = i[0] if isinstance(i, list) else i
labs = {x if isinstance(x, str) else x.get("name", "") for x in (i.get("labels") or [])}
print(" ".join(sorted(labs & {"needs-decision", "needs-access", "roadmap", "blocked-tooling"})))
' 2>/dev/null)"
  if [ -n "$parked" ]; then
    echo "$ID is parked: $parked" >&2
    echo "  A lane would bounce on that label without doing anything. If the question is answered," >&2
    echo "  remove it first:  bd label remove $ID $parked" >&2
    exit 1
  fi
fi

# Already holds one? Hand back the same number rather than a second lane.
for n in $(seq 1 $MAX); do
  [ -f "$SLOTDIR/$n" ] && [ "$(cat "$SLOTDIR/$n")" = "$ID" ] && { echo "$n"; exit 0; }
done

# Never hand out a lane whose LOCK is held, even when the registry says it is free.
#
# The registry and the locks disagree routinely: queue.sh prunes a registry entry as soon as
# bd stops calling the issue in_progress, which happens while the run is still finishing, and
# a hand-dispatch may never have written an entry at all. Consulting only the registry is how
# three runs came to be dispatched onto lane 8 in one evening - harmless that time purely
# because one of them was an extension issue that never opens a Rails test database.
#
# The lock is the fact; the registry is the bookkeeping. Ask the fact.
for n in $(seq 1 $LANES); do
  if [ ! -f "$SLOTDIR/$n" ]; then
    if [ -d "/tmp/${PFX}-lane-$((n + 1)).lock" ]; then
      echo "slot $n looks free but lane $((n + 1)) is locked - skipping" >&2
      continue
    fi
    echo "$ID" > "$SLOTDIR/$n"
    echo "$n"
    exit 0
  fi
done

# FULL IS NOT ALWAYS FULL, and the caller cannot tell the difference from "all lanes busy".
#
# Most of the time the registry is full because stale entries piled up: an issue finished, the
# lane lock went, and nothing gave the number back. Naming those here turns a dead end into an
# instruction, and it is deliberately a SUGGESTION rather than an automatic --gc - a run takes
# its lane lock minutes after it starts, so gc'ing as part of refilling frees lanes that are
# alive. That has already been done once and cost two live runs.
stale=""
for n in $(seq 1 $MAX); do
  [ -f "$SLOTDIR/$n" ] || continue
  [ -d "/tmp/${PFX}-lane-$((n + 1)).lock" ] || stale="$stale slot $n ($(cat "$SLOTDIR/$n"))"
done
echo "all $LANES lanes busy" >&2
if [ -n "$stale" ]; then
  echo "  but these hold no lane lock and are probably finished:$stale" >&2
  echo "  if none of them started in the last few minutes: slot.sh --gc" >&2
fi
exit 1
