#!/bin/bash
# Which workable issues resemble something already closed?
#
#   dupes.sh            report
#   dupes.sh 0.12       report with a looser threshold
#
# WHY. app-6l2d was filed on 2026-08-21 describing a defect that app-mvpo and app-bw2s had fixed
# and deployed the day before. Its own description said "verified still unprotected on master",
# which was untrue when written. Dispatching it cost 93k tokens to reach the conclusion "there
# is nothing to do here" - the run had to read the controllers and both specs on master to be
# sure. That is the cost this script exists to avoid, and the SEARCH BEFORE YOU FILE rule in
# task.js is the half of it that keeps failing, because it relies on an agent remembering.
#
# THE THRESHOLD IS CALIBRATED, NOT GUESSED. The first version of this used 0.28 and reported
# zero matches across seventeen issues, which read as "the queue is clean". It was not: run
# against the known pair, app-6l2d scores 0.254 against app-mvpo and 0.175 against app-bw2s, so
# the threshold was above the very case that motivated it. Both rank #1 and #2 out of every
# closed issue, so the ORDER is reliable even where the absolute number is small - which is why
# the default is 0.15 and why it prints the score rather than just a verdict.
#
# Re-validate after changing the tokeniser or the stop list:
#   the pair above must still come back #1 and #2, or the change made it worse.
#
# It reports resemblance, never a duplicate. Same-parent siblings are excluded because they
# share a vocabulary by construction - app-167e.2 against app-167e.1 is two halves of one epic,
# not a repeat - but anything else it surfaces still needs a person or a triage agent to look.

# PFX was referenced and never assigned, so both scratch files were written to /tmp/-dupes-*.json
# - one pair of names shared by every project on this machine. Two projects running this at once
# scored each other's issues. Named properly now.
PFX="${LOCK_PREFIX:-devloop}"

CFG="$(dirname "${BASH_SOURCE[0]}")/config.sh"
ROOT="${DEVLOOP_ROOT:-$(bash "$CFG" root 2>/dev/null)}"
ROOT="${ROOT:-the workspace root}"
cd "$ROOT" || exit 1
THRESH="${1:-0.15}"

bd list --status open   --json 2>/dev/null > /tmp/${PFX}-dupes-open.json
bd list --status closed --json 2>/dev/null > /tmp/${PFX}-dupes-closed.json
# IN_PROGRESS IS A SEPARATE FETCH, and leaving it out was the whole failure. `bd list --status
# open` means literally open - the moment a lane claims an issue it becomes in_progress and
# vanishes from that list, which is exactly when comparing against it starts to matter. On
# 2026-08-30 app-rvce.5 was in flight, so it was invisible here while app-st1o.1.2 was dispatched
# to build the same page. These are comparison targets, never candidates: something already
# running does not need offering.
bd list --status in_progress --json 2>/dev/null > /tmp/${PFX}-dupes-running.json

python3 - "$THRESH" "$PFX" <<'PY'
import json, re, sys

THRESH = float(sys.argv[1])
PFX = sys.argv[2] if len(sys.argv) > 2 else "devloop"
PARKED = {"needs-decision","needs-access","blocked-tooling","watch","umbrella","roadmap"}
STOP = set("""the a an and or of to in on for with that this is are was were be been it its as
at by from not no we our you your they them site page when what which how all any two more
still into put raw only same other""".split())

def load(p):
    try: d = json.load(open(p))
    except Exception: return []
    return d if isinstance(d, list) else d.get("issues", [])

def toks(i):
    blob = (i.get("title","") + " " + (i.get("description") or "")[:600]).lower()
    return {w for w in re.findall(r"[a-z_][a-z0-9_./]{3,}", blob) if w not in STOP}

def root_of(iid):
    return iid.split(".", 1)[0]

op, cl = load(f"/tmp/{PFX}-dupes-open.json"), load(f"/tmp/{PFX}-dupes-closed.json")
cand = [i for i in op if not (set(i.get("labels") or []) & PARKED) and i.get("issue_type") != "epic"]
ct = [(c, toks(c)) for c in cl]

# OPEN AGAINST OPEN, which is the half this script did not do and the more expensive half.
# Matching against closed work catches "this is already done". It cannot catch two open tickets
# that describe the same thing, because neither is closed yet - and that case costs far more,
# since BOTH get dispatched and both build it. On 2026-08-30 app-rvce.5 and app-st1o.1.2 each
# shipped a bug report template page, at /tools/bug-report-template and /templates/bug-report-
# template, defining the same class with the same slug and two incompatible bodies. Two lanes,
# two pull requests, two trains dropping one of them, and a URL decision at the end of it.
#
# That pair scores 0.19 against each other, above the 0.15 default, so the threshold was never
# the problem - the pair was simply not being compared. Re-validate against it after touching
# the tokeniser, the same way the closed-side pair is used.
running = load(f"/tmp/{PFX}-dupes-running.json")
for r in running:
    r["status"] = "in_progress"
ot_all = [(o, toks(o)) for o in cand + running]

rows = []
pairs = []
seen_pair = set()
cand_ids = {c["id"] for c in cand}
for a, at in ot_all:
    if len(at) < 6 or a["id"] not in cand_ids:
        continue
    for b, bt in ot_all:
        if a["id"] == b["id"] or len(bt) < 6:
            continue
        if root_of(a["id"]) == root_of(b["id"]):
            continue
        key = tuple(sorted((a["id"], b["id"])))
        if key in seen_pair:
            continue
        inter = at & bt
        if not inter:
            continue
        j = round(len(inter) / len(at | bt), 3)
        if j >= THRESH:
            seen_pair.add(key)
            pairs.append((j, a, b))
pairs.sort(reverse=True, key=lambda r: r[0])

for o in sorted(cand, key=lambda i: (i.get("priority", 9), i["id"])):
    ot = toks(o)
    if len(ot) < 6:
        continue
    scored = []
    for c, t in ct:
        if root_of(c["id"]) == root_of(o["id"]):   # siblings share a vocabulary by construction
            continue
        inter = ot & t
        if inter:
            scored.append((round(len(inter) / len(ot | t), 3), c["id"], c["title"][:46]))
    hits = [s for s in sorted(scored, reverse=True)[:2] if s[0] >= THRESH]
    if hits:
        rows.append((o, hits))

print(f"{len(cand)} workable open issues, threshold {THRESH}")
print("(the app-6l2d / app-mvpo pair that motivated this scored 0.254)\n")
if not rows:
    print("  nothing resembles closed work")
for o, hits in rows:
    print(f"{o['id']:<12} P{o.get('priority')}  {o['title'][:46]}")
    for j, cid, ctitle in hits:
        print(f"      ~{j}  closed {cid:<12} {ctitle}")
print()
if pairs:
    print("TWO OPEN ISSUES THAT RESEMBLE EACH OTHER - the expensive case, because both get built:")
    for j, a, b in pairs:
        flag = " <- one is already running" if "in_progress" in (a.get("status",""), b.get("status","")) else ""
        print(f"  ~{j}  {a['id']:<12} {a['title'][:40]}")
        print(f"        {b['id']:<12} {b['title'][:40]}{flag}")
    print()
    print("Read both before dispatching either. If they are the same work, close one INTO the")
    print("other rather than letting two lanes discover it in parallel - the merge afterwards is")
    print("a URL and a design decision, not a rebase.")
else:
    print("no two open issues resemble each other above the threshold")

print("\nResemblance is not duplication - check the closed one before acting.")
PY
