#!/usr/bin/env bash
# Append a note to a bd issue so that it actually lands.
#
# WHY THIS EXISTS. `bd update --append-notes` is a read-modify-write on one text field with no
# serialisation behind it. Two processes that overlap both read the old notes, both append, and
# the second write wins - so one append vanishes. It exits 0 either way and prints the usual
# "Updated issue" line, so nothing anywhere reports the loss.
#
# Measured on 2026-09-06 (app-f3cq): eight concurrent appends to one issue, all exit 0, TWO LOST.
# That matches the two field observations weeks apart, and it matches the load - up to five lanes,
# plus trains, plus the supervisor, all appending notes on a busy day.
#
# WHY IT MATTERS MORE THAN IT LOOKS. Notes are the whole channel between lanes, trains and the
# supervisor: what a gate is, why a ticket was parked, which suspects were disproved. bd's tracker
# has no history for this field, so a note that does not land is not recoverable and leaves no
# trace that it ever existed.
#
# WHAT THIS DOES. Serialises every append behind one lock, then VERIFIES the write landed and
# retries if it did not. The lock makes loss rare; the read-back makes it detectable; the retry
# makes it self-healing. Callers that used `bd update --append-notes` directly should use this.
#
# usage: bd-note.sh <issue-id> <note text>
#        bd-note.sh <issue-id> --note-file <path>
set -u

id=${1:-}; shift || true
[ -n "$id" ] || { echo "usage: bd-note.sh <issue-id> <note text | --note-file PATH>" >&2; exit 2; }

if [ "${1:-}" = "--note-file" ]; then
  [ -n "${2:-}" ] && [ -r "${2:-}" ] || { echo "! bd-note: cannot read note file ${2:-}" >&2; exit 2; }
  note=$(cat "$2")
else
  note="$*"
fi
[ -n "$note" ] || { echo "! bd-note: empty note" >&2; exit 2; }

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PFX="$(bash "$SKILL_DIR/config.sh" lockPrefix 2>/dev/null || echo devloop)"
LOCK=/tmp/${PFX}-bd-write.lock

# VERIFY AGAINST --json, NEVER `bd show`'s human output. Measured 2026-09-06 while building this:
# a note that was genuinely in the field 4 times appeared 0 times in the human output and 4 times
# in the JSON. The human view wraps and elides; grepping it produces FALSE NEGATIVES, which here
# means writing the same note again on every retry. A verifier that manufactures duplicates is
# worse than the silent loss it was meant to catch.
#
# The token is punctuation-stripped and short so that wrapping, indentation and bd's own escaping
# cannot break the match.
token=$(printf '%s' "$note" | tr -cd 'A-Za-z0-9' | cut -c1-24)
[ -n "$token" ] || token=$(printf '%s' "$note" | cut -c1-12)

note_landed() {
  bd show "$id" --json 2>/dev/null | python3 -c "
import json,sys,re
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)                      # unreadable is NOT proof of absence - do not retry on it
d = d[0] if isinstance(d, list) else d
flat = re.sub(r'[^A-Za-z0-9]', '', d.get('notes') or '')
sys.exit(0 if sys.argv[1] in flat else 1)
" "$token"
}

took_lock=""
# Wait for the lock rather than failing on it: the caller wants the note recorded, and a lane that
# gives up here loses exactly the context this whole mechanism exists to preserve. 60 x 0.5s.
for _ in $(seq 1 120); do
  if mkdir "$LOCK" 2>/dev/null; then took_lock=yes; break; fi
  sleep 0.5
done
# Proceeding without the lock is still better than not writing: the read-back below is the real
# guarantee, and an unserialised write that is verified beats a serialised one that never happens.
[ -n "$took_lock" ] || echo "! bd-note: lock busy after 60s, writing unserialised (read-back still applies)" >&2

status=1
for attempt in 1 2 3; do
  bd update "$id" --append-notes "$note" >/dev/null 2>&1
  sleep 0.3                          # the write is not always readable the instant it returns
  note_landed; rc=$?
  if [ "$rc" -eq 0 ]; then
    status=0
    [ "$attempt" -gt 1 ] && echo "bd-note: landed on attempt $attempt" >&2
    break
  fi
  if [ "$rc" -eq 2 ]; then
    # Could not read the issue back at all. That is a failure of the CHECK, not evidence the write
    # was lost, and retrying on it is how duplicates get made. Say so and stop.
    echo "! bd-note: could not read $id back to verify - the note may well have landed, NOT retrying" >&2
    status=0
    break
  fi
  sleep 1
done

[ -n "$took_lock" ] && rmdir "$LOCK" 2>/dev/null

if [ "$status" -ne 0 ]; then
  echo "! bd-note: note did NOT land on $id after 4 attempts - the text follows so it is not lost:" >&2
  printf '%s\n' "$note" >&2
  exit 1
fi
echo "bd-note: appended to $id"
