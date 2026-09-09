#!/bin/bash
# Which parked issues have already been answered?
#
#   answered.sh
#
# WHY THIS EXISTS. A label parks an issue; nothing takes the label off when the question gets
# answered, because the answer arrives in a different session and lands in the notes. So an
# answered issue stays parked, stays out of the ready queue, and gets reported back to the
# owner as still owed - which is how roughly thirty answered decisions were once quoted at
# somebody who had already answered every one of them. That is the failure this looks for.
#
# It found two on its first run: app-j9ig.2, decided on 2026-08-20 with the full scope written
# out underneath and still wearing needs-decision, and app-pw2s, marked UNBLOCKED the same day
# with the tooling fix already made and still wearing blocked-tooling.
#
# PRECISION IS DELIBERATELY POOR. It flagged 22 issues to find those 2 - the words it looks
# for occur in ordinary prose constantly. That is the right trade here: a false positive costs
# one read, a false negative leaves work parked for days. Do not tighten it to make the output
# shorter. Read the excerpt on each hit and judge.
#
# WHAT IT CANNOT DECIDE FOR YOU. A decision marker means somebody looked, NOT that the issue is
# workable. app-5008 carries a decision that reads "(c) define it, then build - but NOT YET",
# which is a deferral, and dispatching it on the strength of the marker cost a full bounce.
# Read WHAT was decided, not merely THAT something was.

CFG="$(dirname "${BASH_SOURCE[0]}")/config.sh"
ROOT="${DEVLOOP_ROOT:-$(bash "$CFG" root 2>/dev/null)}"
ROOT="${ROOT:-the workspace root}"
cd "$ROOT" || exit 1
bd list --status open --json 2>/dev/null > /tmp/answered-open.json

python3 - <<'PY'
import json

PARK = {"needs-decision", "needs-access", "blocked-tooling", "watch"}
# Markers that an answer was recorded, and markers that a question was asked. Position decides:
# the answer has to come after the question it settles, or it is just the hand-back text that
# created the label in the first place.
ANSWER   = ("decided ", "decided:", "unblocked", "answered", "confirmed by", "retested")
QUESTION = ("handed back", "needs a decision", "needs a product decision",
            "question for a person", "parked ", "a person must choose")

try:
    d = json.load(open("/tmp/answered-open.json"))
except Exception:
    d = []
issues = d if isinstance(d, list) else d.get("issues", [])

hits = []
for i in issues:
    labs = set(i.get("labels") or []) & PARK
    if not labs:
        continue
    low = (i.get("notes") or "").lower()
    a = max((low.rfind(m) for m in ANSWER), default=-1)
    q = max((low.rfind(m) for m in QUESTION), default=-1)
    if a > q and a >= 0:
        excerpt = (i.get("notes") or "")[max(0, a - 40):a + 260].replace("\n", " ")
        hits.append((i.get("priority", 9), i["id"], ",".join(sorted(labs)), i["title"][:44], excerpt))

print(f"{len(hits)} parked issues carry an answer marker after the question\n")
for p, iid, labs, title, ex in sorted(hits):
    print(f"{iid:<12} P{p} [{labs}]  {title}")
    print(f"      ...{ex[:220]}")
    print()
print("An answer marker means somebody looked. Read WHAT was decided before dispatching.")
PY
