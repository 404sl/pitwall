#!/bin/bash
# Which lanes are ACTUALLY running right now?
#
#   live.sh
#
# WHY. On 2026-08-21 the supervisor decided three lanes had died, released their slots and
# shipped their branches by hand. One of them had not died: app-fave.2's run was alive the whole
# time and reported 5.9 hours after it started, by which point its branch had been rebased,
# force-pushed and merged underneath it. It handled that gracefully - it verified the work was
# already shipped instead of repeating it - but that was luck, not design.
#
# The check that produced the wrong answer grepped a workflow's agent transcripts for the issue
# id and compared the first hit. It returned EMPTY, and empty was read as "no live run". Empty
# meant the glob missed the files. This is the same mistake task.js warns about for CI: an empty
# check list reads as "not started" and is never a pass. Empty is UNKNOWN, not a verdict.
#
# So this asks a question that cannot answer empty by accident: a run is live if the harness has
# not written its result yet. The task output file is created empty at dispatch and filled on
# completion, so zero-length means running and non-zero means finished. Recency of the workflow
# directory then separates "working" from "hung".
#
# It reports what it does not know as unknown. If a run's issue cannot be identified, it says so
# rather than omitting the row - an omitted row is what caused the incident above.


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
TASKS="${DEVLOOP_TASKS:-$(ls -dt /private/tmp/claude-*/"$SLUG"/*/tasks 2>/dev/null | head -1)}"

now=$(date +%s)

echo "LIVE WORKFLOWS (result not yet written)"
found=0
for f in "$TASKS"/w*.output; do
  [ -e "$f" ] || continue
  [ -s "$f" ] && continue                      # non-empty = finished
  id=$(basename "$f" .output)
  started=$(date -r "$f" '+%m-%d %H:%M')
  age=$(( (now - $(date -r "$f" +%s)) / 60 ))
  found=1
  printf "  %-12s started %s  (%dmin)\n" "$id" "$started" "$age"
done
[ "$found" = "0" ] && echo "  (none)"

echo
echo "WORKFLOW DIRECTORIES BY LAST WRITE"
for d in $(ls -t "$WF" 2>/dev/null | head -14); do
  age=$(( (now - $(date -r "$WF/$d" +%s)) / 60 ))
  # Take the issue id from any agent transcript, not a guessed filename, and strip the
  # trailing punctuation that a sentence leaves on it. An unidentified run is reported as
  # unknown rather than skipped.
  iid=$(cat "$WF/$d"/agent-*.jsonl 2>/dev/null | grep -oham1 'sr-[a-z0-9][a-z0-9]*\(\.[0-9][0-9]*\)*' | head -1)
  [ -z "$iid" ] && iid="UNKNOWN - could not identify"
  state="idle"
  [ "$age" -lt 10 ] && state="working"
  printf "  %-20s %-14s %-8s last write %dmin ago\n" "$d" "$iid" "$state" "$age"
done

echo
echo "A run with no recent write is not proven dead - it may be waiting on CI."
echo "Only an empty result file plus a stale directory plus no open PR justifies that call."
