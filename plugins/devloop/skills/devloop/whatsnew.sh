#!/bin/bash
# What changed in this skill since this session last looked.
#
# A session reads a skill ONCE, at start. A supervisor running for hours is working from
# the version it loaded, so a script added since - or an obligation changed since - is
# invisible to it. There is no mechanism that pushes a skill update into a live session,
# so the session has to ask.
#
#   whatsnew.sh              print unseen entries and mark them seen
#   whatsnew.sh --peek       print unseen entries, change nothing
#   whatsnew.sh --reset      forget what was seen (prints everything next time)
#
# The marker is per WORKSPACE, under the workspace's lock prefix, because two projects
# on this machine run different sessions against the same shared skill and each needs to
# be told once.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PFX="$(bash "$HERE/config.sh" lockPrefix 2>/dev/null || echo devloop)"
MARK="/tmp/${PFX}-tooling-seen"
LOG="$HERE/CHANGELOG.md"

[ -f "$LOG" ] || { echo "no CHANGELOG.md in $HERE"; exit 0; }

case "${1:-}" in
  --reset) rm -f "$MARK"; echo "will report every entry next time"; exit 0 ;;
esac

# Compare by content, not by timestamp: the file is edited in place and a mtime says
# nothing about whether the CONTENT a session was told about has changed.
now="$(shasum "$LOG" | awk '{print $1}')"
seen="$(cat "$MARK" 2>/dev/null || true)"

if [ "$now" = "$seen" ]; then
  exit 0                     # silence, so this is safe to run at every tick
fi

echo "TOOLING CHANGED - $LOG has entries this session has not seen."
echo "Read it before deciding what to do next; it may add an obligation, not just a file."
echo
sed -n '/^## /,$p' "$LOG" | head -60

[ "${1:-}" = "--peek" ] || printf '%s' "$now" > "$MARK"
