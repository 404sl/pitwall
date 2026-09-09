#!/usr/bin/env bash
# What the owner is actually blocking, ordered by how much is waiting on it.
#
# WHY THIS EXISTS. app-wtwej measured it: FOUR OF THE LAST SIX blockers brought to the owner were
# stale. app-hlb8 asked for a smoke test nine days after it had been run, because the TITLE still
# said so and blocker reviews read titles. app-6wgk carried needs-access for access already
# granted. app-q2tw carried needs-access for access that exists and blocks nothing at all.
# app-jkzp.4 was parked while the API it needed had been readable for weeks.
#
# So a list of parked tickets is not a list of things worth someone's attention, and presenting
# one as if it were is how an owner learns to ignore the list.
#
# WHAT THIS MEASURES, and what it deliberately does not. It reports one fact per parked ticket:
# HOW MUCH IS ACTUALLY QUEUED BEHIND IT - dependents, plus open children. That comes from bd's
# own dependent_count and from the id hierarchy, not from reading prose.
#
# It does NOT guess whether a park is stale from the notes. Triage already does that and its
# false positives are on record: "all children closed" ignores dependencies and retained parent
# work, and "answered but parked" misreads acceptance criteria. Guessing produces work; counting
# produces an ordering, and an ordering is what a person needs to decide what to open first.
#
# A park blocking nothing is not necessarily wrong - it may be a real thing the owner must do,
# like a store submission, whose value is not measured in unblocked tickets. It is simply not
# URGENT, and saying so is the point.
set -u

# NO DEFAULT ROOT. This took ${1:-the workspace root}, so running it
# from anywhere else listed ANOTHER WORKSPACE's parked issues with their dependency counts, as
# though they were the caller's own - exit 0, entirely plausible, no hint the root was
# defaulted. Found on 2026-09-09 by pitwall-devloop RUNNING it rather than reading it.
root=${1:-$PWD}
if [ ! -d "$root/.beads" ]; then
  echo "blockers.sh: no .beads tracker at $root - refusing." >&2
  echo "             Guessing a root reports another project's blockers as though they were yours." >&2
  echo "             Pass the workspace root as the first argument." >&2
  exit 3
fi
cd "$root" || { echo "cannot enter $root" >&2; exit 2; }

tmp=$(mktemp -t blockers) || exit 2
trap 'rm -f "$tmp"' EXIT

# Into a file, not a pipe: the python below arrives on stdin as a heredoc, so a pipe into it is
# swallowed and json.load sees an empty string.
bd list --status open --json > "$tmp" 2>/dev/null || { echo "bd list failed" >&2; exit 2; }

python3 - "$root" "$tmp" <<'PY'
import json, subprocess, sys

PARK = {"needs-access", "needs-decision", "blocked-tooling"}
root, path = sys.argv[1], sys.argv[2]

with open(path) as handle:
    rows = json.load(handle)
rows = rows if isinstance(rows, list) else rows.get("issues", rows.get("data", []))

open_ids = {r["id"] for r in rows}
parked = [r for r in rows if PARK & set(r.get("labels") or [])]

# An open child is queued behind its parent as surely as a dependency edge is, and the id IS the
# hierarchy here - bd's parent field is set on only some issues, which has misled a sweep before.
def open_children(issue_id):
    return sorted(i for i in open_ids if i.startswith(issue_id + "."))

scored = []
for r in parked:
    out = subprocess.run(["bd", "show", r["id"], "--json"],
                         capture_output=True, text=True, cwd=root)
    try:
        d = json.loads(out.stdout)
        d = d[0] if isinstance(d, list) else d
    except Exception:
        d = {}
    deps = d.get("dependent_count") or 0
    kids = open_children(r["id"])
    scored.append((deps + len(kids), deps, kids, r))

scored.sort(key=lambda s: (-s[0], s[3].get("priority", 9)))
hot = [s for s in scored if s[0] > 0]
cold = [s for s in scored if s[0] == 0]

def park_of(r):
    return ",".join(sorted(PARK & set(r.get("labels") or [])))

print(f"PARKED AND BLOCKING SOMETHING ({len(hot)}) - ordered by what is waiting")
print()
for total, deps, kids, r in hot:
    print(f"  {r['id']:14} P{r.get('priority')} {park_of(r):16} {r.get('title','')[:52]}")
    if deps:
        print(f"      {deps} ticket(s) depend on it")
    if kids:
        print(f"      {len(kids)} open child(ren): {' '.join(kids[:4])}")
print()
print(f"PARKED AND BLOCKING NOTHING ({len(cold)}) - real work, but nothing waits on it")
print()
for _, _, _, r in cold:
    print(f"  {r['id']:14} P{r.get('priority')} {park_of(r):16} {r.get('title','')[:52]}")
print()
print("Blocking nothing does not mean not worth doing - a store submission unblocks no ticket.")
print("It means it is not urgent, which is the half a list of parked tickets cannot say.")
PY
