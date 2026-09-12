#!/bin/bash
# What can actually be dispatched to a lane right now. Four filters, and each one exists because
# skipping it cost a real dispatch.
#
# 1. PARK LABELS. bd ready ignores them entirely, so the caller's filter is the only gate. And
#    grepping the pretty output for "[epic]" does not work: app-ezfi was typed BUG and labelled
#    umbrella, sailed through the grep, and burned a lane on 2026-08-29. Labels only come out of
#    --json, so this reads --json.
#
# 2. PARENTS. An umbrella has nothing to build - its children carry the work. bd's parent_id is
#    NOT a reliable way to find them: only 62 of 126 open issues had it set, and app-vyom's five
#    children had none, so a parent_id check called it a leaf and cost two more dispatches the
#    same afternoon (app-vyom, then app-dzme, minutes apart).
#
#    THE ID IS THE HIERARCHY HERE. app-vyom.1 is a child of app-vyom, whatever the parent field
#    says. So parenthood is computed by asking whether any issue's id starts with "<id>." - over
#    ALL issues, open and closed, because an umbrella whose children have all shipped is still an
#    umbrella and still has nothing to build.
#
# 3. EPIC TYPE, which is the case bd does model explicitly.
#
# 4. ASSIGNEE, and this one is OPT-IN because the skill is shared. A workspace turns it on by
#    declaring "actor" in its config; without that field nothing is filtered by assignee and a
#    line on stderr says so. The reason it is not on for everybody: most workspaces on this
#    machine have never assigned a ticket to anything, so a gate that excludes unassigned work
#    would take their whole backlog to zero dispatchable with nothing of their own changed.
#
#    Where it IS declared, it is the queue discipline the workspace already documents: the loop
#    takes only what is assigned to it. pitwall-t785 and pitwall-a8s were both offered here on
#    2026-09-12 while sitting in pitwall-planning-session's queue, and a slot was reserved for
#    a8s before a person cross-checked it by hand. bd update --claim does refuse on contact, so
#    nothing was stolen - but the claim was the only thing catching it, and by then the dispatch
#    is already spent.
#
#    THE NAME IS DECLARED, NEVER DERIVED. Deriving it from idPrefix looks right in a workspace
#    whose prefix and project name coincide and matches nothing anywhere else - session-replay
#    assigns to session-replay-devloop while its idPrefix is "sr", so a derived name would offer
#    that workspace none of its own work and would do it silently.
#
# Usage:  dispatchable.sh [--limit N]
# Output: one issue per line - id, priority, title. Nothing else, so it can be read by eye or cut.

set -u

LIMIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="${2:-0}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

# RESOLVE THE WORKSPACE, DO NOT ASSUME ONE.
#
# This used to default to one workspace's path outright, without consulting the config
# and without walking up from the cwd - so being INSIDE another workspace did not save
# you. Run from the pitwall root it answered with app-ky0ni and app-6dp0k: real, open,
# claimable one workspace issues, presented as this workspace's dispatchable work with
# no warning. A supervisor topping up a pool from that output dispatches another
# project's tickets into these lanes.
#
# That is worse than the same bug elsewhere in this skill, because the output is a list
# of ids that looks exactly like the correct answer. There is nothing to notice.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${DEVLOOP_ROOT:-}" ]; then
  ROOT="$DEVLOOP_ROOT"
elif ! ROOT="$(bash "$HERE/config.sh" root 2>/dev/null)" || [ -z "$ROOT" ]; then
  echo "dispatchable.sh: no .pitwall.json or .autofix.json found from $PWD," >&2
  echo "                 and DEVLOOP_ROOT is unset." >&2
  echo "dispatchable.sh: refusing to guess - the ids this prints are claimable, and" >&2
  echo "                 guessing means offering another project's work as if it were yours." >&2
  exit 6
fi
LOCK_PREFIX="${LOCK_PREFIX:-$(bash "$HERE/config.sh" lockPrefix 2>/dev/null || echo devloop)}"
cd "$ROOT" || { echo "not a directory: $ROOT" >&2; exit 6; }

ACTOR="$(bash "$HERE/config.sh" actor 2>/dev/null)" || ACTOR=""
if [ -z "$ACTOR" ]; then
  echo "dispatchable.sh: assignee gate OFF - no \"actor\" in this workspace's config, so" >&2
  echo "                 every ready issue is offered whatever queue it sits in. Add" >&2
  echo "                 \"actor\": \"<project>-devloop\" to the config to turn it on." >&2
fi

# VIA FILES, NOT THE ENVIRONMENT. These payloads carry every issue's notes field, and this
# tracker's notes run to tens of kilobytes each - passing them as environment variables dies with
# "Argument list too long", and it dies in a way that still exits cleanly enough to look like an
# empty result. An empty result here reads as "nothing to dispatch", which is silent and wrong.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/dispatchable.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# ALREADY DONE AND WAITING FOR THE LANDER. An issue whose branch has an open pull request
# carrying the label is finished work sitting in a queue - dispatching it rebuilds something that
# is already green. bd cannot see this: the issue stays open and in_progress, which is exactly
# what a rework in flight looks like, so the pull request's label is the only thing that tells
# them apart. app-bt5g was offered this way on 2026-08-29, minutes after its rebase went green.
# The slugs come from each configured repo's own origin, not from a list. Hardcoded
# they were one workspace's four, so in any other workspace this check queried
# repositories that have nothing to do with it, found nothing, and excluded nothing -
# meaning finished work waiting for the lander was offered for dispatch again.
while read -r slug; do
  [ -n "$slug" ] || continue
  gh pr list --repo "$slug" --label lane-verified --state open --json headRefName \
    --jq '.[].headRefName' 2>/dev/null | sed 's#^devloop/##'
done < <(bash "$HERE/config.sh" repos 2>/dev/null | python3 -c '
import json,sys,os,subprocess
try: repos=json.load(sys.stdin)
except Exception: sys.exit(0)
root=sys.argv[1]
for name,cfg in repos.items():
    p=os.path.join(root,cfg.get("path",name))
    try:
        url=subprocess.run(["git","-C",p,"remote","get-url","origin"],
                           capture_output=True,text=True,timeout=10).stdout.strip()
    except Exception: continue
    if not url: continue
    print(url.rstrip("/").removesuffix(".git").split("github.com")[-1].lstrip(":/"))
' "$ROOT") > "$TMP/inflight.txt"

# ALREADY IN A LANE RIGHT NOW. The slot registry holds one issue id per occupied slot. A lane
# that has not yet pushed has no pull request, so the label check above cannot see it - between
# dispatch and first push an issue looks completely free. Dispatching it twice would run two
# lanes over the same branch.
cat "/tmp/${LOCK_PREFIX}-slots"/* 2>/dev/null > "$TMP/inlane.txt" || : > "$TMP/inlane.txt"

bd ready --json >"$TMP/ready.json" 2>/dev/null
bd list --all --json >"$TMP/every.json" 2>/dev/null
[ -s "$TMP/every.json" ] || bd list --status open --json >"$TMP/every.json" 2>/dev/null

[ -s "$TMP/ready.json" ] || { echo "bd ready returned nothing - is bd on PATH and this the workspace root?" >&2; exit 6; }

LIMIT="$LIMIT" TMP="$TMP" ACTOR="$ACTOR" python3 <<'PY'
import json, os, re, sys

tmp = os.environ["TMP"]
ready = json.load(open(os.path.join(tmp, "ready.json")))
try:
    every = json.load(open(os.path.join(tmp, "every.json")))
except Exception:
    every = []
limit = int(os.environ["LIMIT"] or 0)
actor = os.environ["ACTOR"]

park = {"umbrella", "needs-access", "needs-decision", "watch", "blocked-tooling", "roadmap"}

def read_ids(name):
    try:
        return {l.strip() for l in open(os.path.join(tmp, name)) if l.strip()}
    except Exception:
        return set()

# Two ways an issue is already being worked, and BOTH are needed. A lane that has pushed shows
# up as a labelled pull request; a lane that has not yet pushed shows up only in the slot
# registry. Reading one and not the other leaves a window - between dispatch and first push -
# where an issue looks completely free. The registry file was written and then not read here on
# 2026-08-29, which put a running lane back on the list minutes after it started.
inflight = read_ids("inflight.txt") | read_ids("inlane.txt")

# Parenthood from the id, over every issue regardless of status.
ids = [r["id"] for r in every] or [r["id"] for r in ready]
parents = set()
for i in ids:
    if "." in i:
        parents.add(i.rsplit(".", 1)[0])

out = []
elsewhere = {}
for r in ready:
    labels = set(r.get("labels") or [])
    if labels & park:
        continue
    if r.get("issue_type") == "epic":
        continue
    if r["id"] in parents:
        continue
    if r["id"] in inflight:
        continue
    if actor:
        assignee = r.get("assignee") or "nobody"
        if assignee != actor:
            elsewhere[assignee] = elsewhere.get(assignee, 0) + 1
            continue
    out.append(r)

if limit:
    out = out[:limit]

for r in out:
    print("%-14s P%-3s %s" % (r["id"], r.get("priority"), (r.get("title") or "")[:66]))

if not out:
    if elsewhere:
        held = ", ".join("%s (%d)" % (who, n) for who, n in sorted(elsewhere.items()))
        print("(nothing dispatchable - this loop takes only work assigned to %s, and every "
              "ready issue is in another queue: %s)" % (actor, held))
    else:
        print("(nothing dispatchable - every ready issue is parked, an epic, or a parent)")

# 4. RESEMBLES SOMETHING ALREADY RUNNING. dupes.sh does this properly and against closed work
# too, but nothing ran it - a check that lives in its own script only fires when somebody
# remembers it exists, and the dispatch decision is made here. So the cheap half of it runs here,
# where it can actually stop a bad dispatch, using data this script has already loaded.
#
# The case it is for: on 2026-08-30 app-rvce.5 and app-st1o.1.2 each built a bug report template
# page, at two URLs, defining the same class with the same slug. Two lanes, two pull requests,
# two trains dropping one of them, and a URL decision at the end. Neither was closed, so nothing
# looking at closed work could have seen it.
#
# It WARNS and does not filter. Tool pages resemble each other by construction and most pairs
# here are fine; a filter would quietly starve the queue. The judgement stays with the caller.
STOP = set("""the a an and or of to in on for with that this is are was were be been it its as
at by from not no we our you your they them site page when what which how all any two more
still into put raw only same other""".split())

def words(r):
    blob = ((r.get("title") or "") + " " + (r.get("description") or "")[:600]).lower()
    return {w for w in re.findall(r"[a-z_][a-z0-9_./]{3,}", blob) if w not in STOP}

running = [r for r in every if r.get("status") == "in_progress"]
warned = []
for o in out:
    ow = words(o)
    if len(ow) < 6:
        continue
    for b in running:
        if b["id"] == o["id"] or b["id"].split(".")[0] == o["id"].split(".")[0]:
            continue
        bw = words(b)
        if len(bw) < 6:
            continue
        j = len(ow & bw) / len(ow | bw)
        if j >= 0.15:
            warned.append((round(j, 3), o, b))

if warned:
    warned.sort(reverse=True, key=lambda t: t[0])
    print()
    print("CHECK BEFORE DISPATCHING - these resemble something a lane is building right now:")
    for j, o, b in warned:
        print("  ~%s  %-14s %s" % (j, o["id"], (o.get("title") or "")[:44]))
        print("          %-14s %s  (running)" % (b["id"], (b.get("title") or "")[:44]))
    print()
    print("  Read both. If they are the same work, close one INTO the other now - discovering it")
    print("  after both have pull requests costs a URL decision, not a rebase.")
PY
