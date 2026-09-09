#!/usr/bin/env bash
# Is the merge lock held by something that is still alive?
#
# WHY THIS EXISTS. queue-watch.sh asks only `[ -d $lock ]` and calls that "a lander is running".
# A lander that dies without releasing therefore reads as a healthy train FOREVER: the READY TO
# LAND event stops firing, the environment-drift alarm stays suppressed, and the pipeline goes
# quiet with green pull requests sitting in the queue. On 2026-09-09 that cost 38 minutes and a
# person had to go and look, because nothing anywhere reported an error.
#
# WHY NOT JUST AGE. A legitimate hold can be very long. The lander deploys staging and production
# inside the lock and each deploy carries a 1500s timeout, so an hour of holding can be perfectly
# healthy. Age alone would cry wolf on exactly the run that must not be disturbed.
#
# WHAT IT MEASURES INSTEAD: whether the run that took the lock is still WRITING. Every lander step
# is a subagent, and a live one appends to its transcript continuously while it polls CI. So the
# question is answered by attribution, not by a clock - find the workflow whose journal reported
# this exact token, and look at how long ago anything in that directory was touched.
#
# THE PID IN THE TOKEN IS USELESS. It is $$ of the shell that ran printf, which exits immediately,
# so `ps -p` reports "not running" for a perfectly live lander. Do not reintroduce that check.
set -u

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root=${DEVLOOP_ROOT:-$PWD}
quiet=0
silent_for=600   # seconds of no writing before a held lock is called dead
while [ $# -gt 0 ]; do
  case "$1" in
    --root)   root=$2; shift 2 ;;
    --quiet)  quiet=1; shift ;;
    --silent-for) silent_for=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PFX="$(bash "$skill/config.sh" lockPrefix 2>/dev/null)" || PFX=""
if [ -z "$PFX" ]; then
  echo "lock-check.sh: cannot resolve lockPrefix from the workspace config - refusing to guess." >&2
  echo "               Guessing it reports on another workspace's merge lock." >&2
  exit 3
fi
lock="/tmp/${PFX}-merge.lock"

[ -d "$lock" ] || { [ "$quiet" = 1 ] || echo "no merge lock held"; exit 0; }

token=$(cat "$lock/holder" 2>/dev/null)
now=$(date +%s)
held_since=$(stat -f %m "$lock/holder" 2>/dev/null || stat -c %Y "$lock/holder" 2>/dev/null || echo "$now")
held_min=$(( (now - held_since) / 60 ))

if [ -z "$token" ]; then
  echo "MERGE LOCK held ${held_min}m with an EMPTY holder file - no token to attribute or compare."
  echo "  Nothing can release this safely by token. Confirm no deploy is running, then clear by hand."
  exit 1
fi

# Find the run that reported this token. Journals live per session; search them all rather than
# assuming this session owns the lock - another session on this machine may legitimately hold it.
owner=""
for j in "$HOME"/.claude/projects/*/*/subagents/workflows/*/journal.jsonl; do
  [ -f "$j" ] || continue
  if grep -qF "$token" "$j" 2>/dev/null; then owner=$(dirname "$j"); break; fi
done

if [ -z "$owner" ]; then
  echo "MERGE LOCK held ${held_min}m by ${token} - NO workflow journal claims this token."
  echo "  Either the run predates the transcripts on this machine, or it was taken outside a workflow."
  echo "  Treat as unattributable: confirm nothing is deploying before touching it."
  exit 1
fi

newest=$(ls -t "$owner"/*.jsonl 2>/dev/null | head -1)
[ -n "$newest" ] || newest="$owner/journal.jsonl"
last=$(stat -f %m "$newest" 2>/dev/null || stat -c %Y "$newest" 2>/dev/null || echo "$now")
idle=$(( now - last ))

if [ "$idle" -lt "$silent_for" ]; then
  [ "$quiet" = 1 ] || echo "merge lock held ${held_min}m by ${token} - its run wrote $(( idle / 60 ))m ago, ALIVE. Leave it."
  exit 0
fi

echo "MERGE LOCK LOOKS DEAD: held ${held_min}m by ${token}, its run has not written for $(( idle / 60 ))m."
echo "  run: ${owner}"
echo "  Nothing will land until this is released, and queue-watch reads the lock as a live train,"
echo "  so it will stay silent about the pull requests piling up behind it."
echo "  BEFORE RELEASING, confirm no deploy is in flight - a mid-deploy train is legitimately slow:"
echo "    ps ax | grep -E 'mina|land-one|deploy-one' | grep -v grep"
echo "    staging and production and origin/master should all read the SAME revision;"
echo "    staging AHEAD of production means a train is between its two deploys - leave it alone."
echo "  Then release it by TOKEN, never with a bare rm:"
echo "    [ \"\$(cat ${lock}/holder)\" = \"${token}\" ] && rm -rf ${lock} || echo NOT_MINE"
exit 1
