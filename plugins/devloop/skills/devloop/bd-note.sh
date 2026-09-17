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
#        PITWALL_SESSION=<name>  names the writer in the stamp; else $USER, else unknown
#
# WHAT THE READ-BACK COVERS, AND WHAT IT CANNOT. It compares the WHOLE note against the stored
# field, so it catches loss or transformation BETWEEN this script and bd - truncation, escaping,
# and bd's own input handling. It cannot catch text the CALLER already destroyed before calling.
# Measured on pitwall-3tkj (2026-09-17): the note was built as a double-quoted shell string
# containing backticks, the shell ran them as command substitution, and bd stored faithfully what
# it was handed - two code lines short. No read-back inside this script could have seen that.
#
# So pass a code-carrying note through --note-file, or through a heredoc quoted as <<'EOF' so that
# nothing expands before this script is reached:
#
#   cat > note.txt <<'NOTE'
#   Line 221 is `quiet = argv[1]` and the block unpacks quiet=argv[1] from the same slot.
#   NOTE
#   bash bd-note.sh <issue-id> --note-file note.txt
#
# Then re-read the issue afterwards - bd show <issue-id> --json, never the human output - and
# check that the text you meant is there.
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
# Both sides are punctuation-stripped before anything is compared, so that wrapping, indentation
# and bd's own escaping cannot break the match.

writer=$(printf '%s' "${PITWALL_SESSION:-${USER:-unknown}}" | tr -s '[:space:]' '-')
writer=${writer#-}; writer=${writer%-}
[ -n "$writer" ] || writer=unknown
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stamped=$(printf '\n%s %s\n%s' "$now" "$writer" "$note")
stamp_line=$(printf '%s %s' "$now" "$writer")

notes_field() {
  bd show "$id" --json 2>/dev/null | python3 -c "
import json,re,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
d = d[0] if isinstance(d, list) else d
sys.stdout.write(re.sub(r'[^A-Za-z0-9]', '', d.get('notes') or ''))
"
}

note_landed() {
  bd show "$id" --json 2>/dev/null | python3 -c "
import io,json,re,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)                      # unreadable is NOT proof of absence - do not retry on it
d = d[0] if isinstance(d, list) else d
alnum = lambda c: re.match(r'[A-Za-z0-9]', c) is not None
stored = re.sub(r'[^A-Za-z0-9]', '', d.get('notes') or '')
want, stamp, pre_path, pre_read = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
keep = [i for i, c in enumerate(want) if alnum(c)]
whole = ''.join(want[i] for i in keep)
if not whole:
    sys.exit(1)
pre = io.open(pre_path, encoding='utf-8', errors='replace').read() if pre_read else None
region = stored[len(pre):] if pre is not None and stored.startswith(pre) else stored
if whole in region:
    sys.exit(0)
mark = re.sub(r'[^A-Za-z0-9]', '', stamp)
at_mark = region.rfind(mark)
if at_mark < 0:
    sys.exit(1)
mine = region[at_mark + len(mark):]
lo, hi = 0, len(whole)
while lo < hi:
    mid = (lo + hi + 1) // 2
    if whole[:mid] in mine:
        lo = mid
    else:
        hi = mid - 1
at = keep[lo] if lo < len(keep) else len(want)
sys.stderr.write(
    '! bd-note: stored note differs from what was sent - diverges at character %d of %d, NOT retrying\n'
    % (at + 1, len(want)))
sys.stderr.write('!   first divergent characters: %r\n' % want[at:at + 60])
sys.exit(3)
" "$note" "$stamp_line" "$pre_file" "$pre_read"
}

pre_file=$(mktemp "${TMPDIR:-/tmp}/bd-note-pre.XXXXXX")
trap 'rm -f "$pre_file"' EXIT

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
diverged=""
for attempt in 1 2 3; do
  if notes_field > "$pre_file"; then pre_read=yes; else pre_read=""; : > "$pre_file"; fi
  bd update "$id" --append-notes "$stamped" >/dev/null 2>&1
  sleep 0.3                          # the write is not always readable the instant it returns
  note_landed; rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]; then
    status=0
    [ "$rc" -eq 3 ] && diverged=yes
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
  printf '%s\n' "$stamped" >&2
  exit 1
fi
if [ -n "$diverged" ]; then
  echo "! bd-note: the note as sent follows, so it is not lost whatever landed:" >&2
  printf '%s\n' "$stamped" >&2
  echo "bd-note: appended to $id - stored text differs from what was sent, see warning"
else
  echo "bd-note: appended to $id"
fi
