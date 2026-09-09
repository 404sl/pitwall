#!/bin/bash
# Would triage bounce this? Answer from the tracker before spending a dispatch.
#
#   precheck.sh app-xxxx      prints GO or STOP with the reason
#
# WHY. A triage bounce costs about 85,000 tokens. Roughly twenty of them in one session is
# 1.7 million tokens spent learning things the ticket already said - a needs-feedback label,
# an epic, an open dependency, an entry in the park file. Every one of those is readable
# here for nothing.
#
# This does NOT replace triage. Triage still judges the things that need judgement: whether
# a choice changes what ships, whether an approach can work at all. This only catches the
# mechanical refusals, which are the ones that are pure waste.
ID="$1"
[ -z "$ID" ] && { echo "usage: precheck.sh <issue-id>" >&2; exit 2; }
ROOT=the workspace root

# /tmp is shared across every project on this machine, so the lock paths are namespaced by the
# workspace's lockPrefix rather than fixed. Read it here rather than hardcoding: two projects
# with the same prefix collide on the lane locks, and the lane lock is the only thing stopping
# two lanes from sharing a test database.
PFX="$(bash "$CFG" lockPrefix 2>/dev/null || echo devloop)"

export BEADS_DIR="$ROOT/.beads"

J=$(cd "$ROOT" && bd show "$ID" --json 2>/dev/null)
[ -z "$J" ] && { echo "STOP  $ID: bd returned nothing - check the id"; exit 1; }

# Closed issues, for the duplicate check below. Cheap, and it has paid for itself twice.
(cd "$ROOT" && bd list --status closed --json 2>/dev/null) > /tmp/precheck-closed.json

echo "$J" | python3 -c '
import json,sys,os,subprocess
d=json.load(sys.stdin)
d=d[0] if isinstance(d,list) else d
iid=d.get("id")
labels=set(d.get("labels") or [])
reasons=[]

if d.get("status")=="closed": reasons.append("already closed")
if (d.get("issue_type") or d.get("type"))=="epic": reasons.append("is an epic - epics are never dispatched")
for l in ("needs-decision","needs-access","blocked-tooling","watch","umbrella","roadmap"):
    if l in labels: reasons.append("labelled "+l)

# an OPEN issue it depends on (the tracker is the only record - there is no park file)
if int(d.get("dependency_count") or 0) > 0:
    out=subprocess.run(["bd","show",iid],capture_output=True,text=True,
                       cwd="the workspace root").stdout
    blk=[]
    inblock=False
    for line in out.splitlines():
        if line.startswith("DEPENDS ON"): inblock=True; continue
        if inblock:
            if not line.strip(): break
            if "○" in line: blk.append(line.strip()[:60])
    if blk: reasons.append("blocked by open: "+"; ".join(blk))

# work sitting only in a worktree, with no branch pushed
wt="/private/tmp/${PFX}-worktrees/"+iid
if os.path.isdir(wt):
    dirty=subprocess.run(["git","-C",wt,"status","--porcelain"],capture_output=True,text=True).stdout.strip()
    if dirty:
        reasons.append("UNCOMMITTED WORK in "+wt+" - dispatching would destroy it")
    elif d.get("status")=="in_progress":
        reasons.append("a lane is running it now (worktree present, status in_progress)")
    else:
        reasons.append("a stale worktree remains at "+wt+" - remove it before dispatching, or the lane collides")

# A ticket that says in its own words it was handed back, but carries no label saying so.
#
# The parking labels are the only thing this script used to read, so an issue whose notes
# open "Handed back for a person: this needs a product decision, not an implementation"
# came back GO and went straight out to a lane. That is a whole dispatch spent rediscovering
# a conclusion already written on the ticket. Six were sitting at the top of the ready queue
# at once, three of them in the first eight lines of it.
#
# The labelling is what should be fixed, and is - but the label is applied by hand and will
# be forgotten again, so read the text too. Say it plainly and let whoever is dispatching
# label it, rather than guessing which flavour of parked it is.
text = ((d.get("description") or "") + "\n" + (d.get("notes") or "")).lower()
# A hand-back that has since been answered is not a hand-back. The answer is written as a
# DECIDED line, by the owner or by the supervisor, and it always comes after the hand-back
# text it settles - so compare positions rather than just asking whether both appear.
# Note what this does NOT claim: that the issue is workable. A DECIDED note can say "not
# yet" as easily as it can say "do (a)", which has already cost one dispatch. It only says
# somebody looked, so the question goes back to triage instead of stopping here.
answered = text.rfind("decided") > text.rfind("handed back")
if answered:
    text = ""
# A DELIBERATE non-label is also a decision.
# The owner left app-0286 and app-4296 unlabelled on purpose, writing that they are ordinary
# work and that labelling them "would only refill the queue that was just cleared". The
# hand-back text below is older than that decision, so this check was stopping exactly the
# work they had just released. Absence of a label can be chosen, not only forgotten.
if "left unlabelled" in text or "removing it again" in text or "removing again" in text:
    pass
elif not (labels & {"needs-decision","needs-access","blocked-tooling","watch","umbrella","roadmap"}):
    for phrase in ("handed back for a person", "handed back",
                   "needs a product decision", "this needs a decision",
                   "a product call, not", "not an implementation"):
        if phrase in text:
            reasons.append("its own text says it was handed back (" + phrase
                           + ") but it carries no parking label - label it, do not dispatch it")
            break

# DOES THIS ALREADY EXIST, CLOSED?
#
# Two dispatches were spent today rediscovering that the work was already done. app-6l2d
# described a defect that had shipped the day before it was filed; app-0q0x asked for a spec
# pin that the PR it was filed against had already added, two hours earlier. Each cost about
# 90,000 tokens to reach the answer "there is nothing here".
#
# dupes.sh existed before both of them and would have caught both - it ranked the real match
# first at 0.254 and 0.265, with the runner-up around 0.13. It was simply never run before
# dispatching, which is the whole lesson: a check nobody runs is not a check. So it lives here,
# in the path every dispatch already goes through.
#
# It STOPS rather than warns. A false positive costs one read; a false negative costs a
# dispatch. Read the named issue and dispatch anyway if it is genuinely different.
try:
    closed = json.load(open("/tmp/precheck-closed.json"))
    closed = closed if isinstance(closed, list) else closed.get("issues", [])
except Exception:
    closed = []

if closed and not reasons:
    import re
    SW = set("""the a an and or of to in on for with that this is are was were be been it its
    as at by from not no we our you your they them site page when what which how all any two
    more still into put raw only same other""".split())
    def toks(x):
        blob = (x.get("title","") + " " + (x.get("description") or "")[:600]).lower()
        return {w for w in re.findall(r"[a-z_][a-z0-9_./]{3,}", blob) if w not in SW}
    mine = toks(d)
    if len(mine) >= 6:
        best = (0.0, None, None)
        def _root(x):               # app-nwfv.2 -> app-nwfv ; app-nwfv -> app-nwfv
            return x.split(".", 1)[0]
        for c in closed:
            if c.get("id") == iid:      # an issue is not a duplicate of itself
                continue
            # Siblings of one parent share a vocabulary BY CONSTRUCTION - app-nwfv.1/.2/.3 are
            # the same change in three repos, and scored 0.41 and 0.36 against each other. That
            # is the split working, not duplication. dupes.sh has excluded these from the start;
            # this copy did not, and over-fired on the first split it met.
            if _root(c.get("id") or "") == _root(iid):
                continue
            t = toks(c)
            if not (mine & t): continue
            j = len(mine & t) / len(mine | t)
            if j > best[0]: best = (j, c.get("id"), (c.get("title") or "")[:52])
        if best[0] >= 0.20:
            reasons.append("resembles CLOSED %s (%.2f) %r - read it before dispatching; two runs "
                           "today were spent rediscovering work that was already shipped"
                           % (best[1], best[0], best[2]))

if reasons:
    print("STOP  "+iid+": "+" | ".join(reasons))
    sys.exit(1)
print("GO    "+iid+": nothing mechanical blocks it - triage will judge the rest")
'
