#!/bin/bash
# What is ACTUALLY running in each lane, as opposed to what the slot registry claims.
#
# WHY. The registry records intent: a slot is claimed by hand before the workflow is launched,
# and released by hand when its completion notification is read. Both halves get missed. On
# 2026-08-29 three slots were claimed and never launched, and later four were held by lanes that
# had finished hours earlier - each time the registry said six lanes were busy while two were
# working, and each time the owner noticed before the supervisor did.
#
# A slot file proves somebody intended to run something. It does not prove anything is running.
# This compares the registry against the workflow transcripts, which only move while an agent is
# actually writing, and reports the difference.
#
# Usage:  lanes.sh [--stale-minutes N]     default 20
# Exit:   0 always - this reports, it does not act. Releasing a slot is a decision.

set -u

STALE=20
while [ $# -gt 0 ]; do
  case "$1" in
    --stale-minutes) STALE="${2:-20}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

SLOTS="/tmp/${LOCK_PREFIX:-devloop}-slots"

[ -d "$SLOTS" ] || { echo "no slot registry at $SLOTS - no lanes have ever been claimed"; exit 0; }

# THE HARNESS DIRECTORIES ARE DERIVED FROM THE WORKSPACE, NOT NAMED.
# These used to be one machine's absolute paths, pinned to one project and one session of it.
# Anywhere else that reported another project's runs as though they were this workspace's.
# The harness names its per-project directory after the workspace path with the separators
# swapped, so it can be computed; the session inside it is whichever ran most recently.
CFG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
ROOT="${DEVLOOP_ROOT:-$(bash "$CFG" root 2>/dev/null)}"
[ -n "$ROOT" ] || { echo "$(basename "${BASH_SOURCE[0]}"): no workspace resolved - refusing to guess." >&2; exit 6; }
SLUG="$(printf '%s' "$ROOT" | sed 's|/|-|g')"
WF="${DEVLOOP_WORKFLOW_DIR:-${DEVLOOP_WF:-$HOME/.claude/projects/$SLUG}}"

now=$(date +%s)

# The newest write anywhere a working lane touches, per issue id. A workflow's args are not
# stored anywhere readable, so match on the worktree path the lane uses, which carries the id.
#
# NOT the worktree directory's OWN mtime. That only moves when an entry is created or removed at
# the top level, which a lane does once - at checkout - and then never again. On 2026-08-30 it
# reported app-rvce.4 and app-rvce.5 as 36 and 48 minutes stale while both were mid-spec-run,
# writing coverage and sprockets caches seconds earlier, and two live lanes were nearly released.
#
# Walking the whole tree would be right and is far too slow - a Rails worktree is tens of
# thousands of files. These paths are what actually churns: the git index is rewritten by every
# status, add and commit; tmp, log and coverage are written throughout a spec run.
freshest_for() {
  local id="$1" best=0 m wt gitdir
  # A rework lane checks out to "<id>-rework" so it cannot collide with a build lane holding the
  # same id. Probing only the bare path reported a running rework as having no worktree at all,
  # which reads as "finished, release the slot" once it crosses the staleness threshold.
  for wt in /tmp/${LOCK_PREFIX:-devloop}-worktrees/"$id" /private/tmp/${LOCK_PREFIX:-devloop}-worktrees/"$id" \
            /tmp/${LOCK_PREFIX:-devloop}-worktrees/"$id"-rework /private/tmp/${LOCK_PREFIX:-devloop}-worktrees/"$id"-rework; do
    [ -d "$wt" ] || continue

    # A linked worktree's .git is a file holding "gitdir: <path>" - that directory is where the
    # index lives, and the index is the single most reliable proof a lane is still working.
    gitdir=""
    if [ -f "$wt/.git" ]; then
      gitdir=$(sed -n 's/^gitdir: //p' "$wt/.git" 2>/dev/null)
    elif [ -d "$wt/.git" ]; then
      gitdir="$wt/.git"
    fi

    for probe in "$wt" "$wt/tmp" "$wt/log" "$wt/coverage" "$wt/tmp/cache" \
                 ${gitdir:+"$gitdir" "$gitdir/index" "$gitdir/HEAD"}; do
      [ -e "$probe" ] || continue
      m=$(stat -f %m "$probe" 2>/dev/null) || continue
      [ "$m" -gt "$best" ] && best=$m
    done
  done
  echo "$best"
}

# HOW OLD IS THE WORKFLOW ITSELF. A worktree goes quiet whenever a lane is reading rather than
# writing, which is most of a design or review phase, so worktree age alone cannot tell a slow
# lane from a dead one. The transcript can: an agent that is running writes to its own jsonl
# continuously, so a transcript that has not moved in half an hour means nothing is running.
#
# On 2026-08-30 app-4m7h sat 47 minutes with a worktree, no pull request and a transcript last
# written at 05:28. It was hung, and finding that out took a manual hunt through the workflow
# directories. This does that hunt.
transcript_age() {
  local id="$1" newest=0 m d
  [ -d "$WF" ] || { echo ""; return; }
  for d in "$WF"/*/; do
    [ -f "$d/journal.jsonl" ] || continue
    grep -q -- "$id" "$d/journal.jsonl" 2>/dev/null || continue
    for f in "$d"/agent-*.jsonl "$d/journal.jsonl"; do
      [ -f "$f" ] || continue
      m=$(stat -f %m "$f" 2>/dev/null) || continue
      [ "$m" -gt "$newest" ] && newest=$m
    done
  done
  [ "$newest" = "0" ] && { echo ""; return; }
  echo $(( (now - newest) / 60 ))
}

echo "slot  issue           worktree      last touched"
echo "----  --------------  ------------  ------------"
claimed=0
suspect=""
for f in "$SLOTS"/*; do
  [ -e "$f" ] || continue
  claimed=$((claimed + 1))
  slot=$(basename "$f")
  id=$(cat "$f" 2>/dev/null)
  m=$(freshest_for "$id")
  if [ "$m" = "0" ]; then
    # No worktree is ambiguous THREE ways, not two: handed off, dead, or simply too new to have
    # checked one out. A lane spends its first minutes reading the ticket and the codebase before
    # it runs 'git worktree add', so a slot claimed moments ago always looks like this. The slot
    # file's own mtime is when the claim was written, which separates the third case from the
    # other two - without it every fresh dispatch reports itself as suspect.
    claimed_at=$(stat -f %m "$f" 2>/dev/null || echo 0)
    claim_age=$(( (now - claimed_at) / 60 ))
    if [ "$claim_age" -le "$STALE" ]; then
      printf '%-5s %-15s %-13s %s\n' "$slot" "$id" "none" "claimed ${claim_age}m ago - starting up"
    else
      printf '%-5s %-15s %-13s %s\n' "$slot" "$id" "none" "no worktree - not started, or already handed off"
      suspect="$suspect $id"
    fi
  else
    age=$(( (now - m) / 60 ))
    printf '%-5s %-15s %-13s %sm ago\n' "$slot" "$id" "present" "$age"
    [ "$age" -gt "$STALE" ] && suspect="$suspect $id"
  fi
done

echo
echo "claimed: ${claimed}"
if [ -n "$suspect" ]; then
  # A LIVE TRANSCRIPT CLEARS THE SUSPICION ENTIRELY, rather than being reported alongside it.
  # Docs lanes routinely work without a /tmp worktree at all, so the worktree probe is blind for
  # a whole repository and every one of them lands in this list while working perfectly. A
  # SUSPECT section that is mostly healthy lanes is one nobody reads.
  dead=""; alive=""
  for id in $suspect; do
    ta=$(transcript_age "$id")
    if [ -z "$ta" ]; then
      dead="${dead}  $id   (no workflow transcript found - cannot say)\n"
    elif [ "$ta" -gt "$STALE" ]; then
      dead="${dead}  $id   TRANSCRIPT SILENT ${ta}m - nothing is running, this lane is dead\n"
    else
      alive="${alive}  $id (transcript ${ta}m ago)\n"
    fi
  done

  [ -n "$alive" ] && { echo "Working, no worktree yet or none used - docs lanes often have none:"; printf "$alive"; echo; }

  if [ -z "$dead" ]; then
    echo "no dead lanes - every claimed slot has something running"
    exit 0
  fi

  echo "DEAD - stop the workflow, then: kill-lane.sh --slot N --id <id>"
  printf "$dead"
  echo
  echo "Check each against its pull request before releasing - a lane between phases writes"
  echo "nothing for a while, and a handed-off lane removes its own worktree, so 'none' is"
  echo "ambiguous on its own:"
  echo "  gh pr list --repo your-org/your-app --head devloop/<id> --state all --json number,state"
  echo "  bash slot.sh --release <id>"
else
  echo "no suspects - every claimed slot has a recent worktree"
fi
