#!/usr/bin/env bash
# Report default-branch CI transitions for one repository, keyed on the commit the
# branch actually points at.
#
# `gh run list --branch master --limit 1` orders by run creation, not by history, so
# an old run somebody re-ran - or a second workflow on the same branch - sorts first
# while carrying an ANCESTOR's head sha. Watching the conclusion alone then reports
# that ancestor's result as master's. A false red is noise; a false green invites a
# deploy off a failing build, so this resolves origin/master first and ignores every
# run that is not about that exact commit.
set -u

repo_path=""
repo=""
once=0
interval=60
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) repo_path=$2; shift 2 ;;
    --repo)      repo=$2;      shift 2 ;;
    --interval)  interval=$2;  shift 2 ;;
    --once)      once=1;       shift   ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo_path" ] || { echo "usage: master-watch.sh --repo-path <dir> [--repo owner/name] [--once] [--interval N]" >&2; exit 2; }
cd "$repo_path" || exit 2

# Resolve master HEAD, then the verdict of the runs whose head IS that commit.
# Prints "<state>\t<sha>\t<title>"; state is pending when nothing has finished for
# this commit yet, which is not a result and must not be announced either way.
poll() {
  git fetch origin master --quiet || true
  local head
  head=$(git rev-parse origin/master) || return 1
  gh run list ${repo:+--repo "$repo"} --branch master --limit 40 \
     --json headSha,status,conclusion,displayTitle 2>/dev/null \
   | HEAD_SHA="$head" python3 -c '
import json, os, sys
head = os.environ["HEAD_SHA"]
try:
    runs = json.load(sys.stdin)
except Exception:
    runs = []
mine = [r for r in runs if r.get("headSha") == head]
done = [r for r in mine if r.get("status") == "completed"]
short = head[:8]
if not done:
    print("pending\t%s\t" % short); sys.exit()
bad = [r for r in done if r.get("conclusion") != "success"]
pick = bad[0] if bad else done[0]
print("%s\t%s\t%s" % ("failure" if bad else "success", short, (pick.get("displayTitle") or "")[:60]))
'
}

if [ "$once" = "1" ]; then
  poll; exit 0
fi

prev_state=""
prev_sha=""
while true; do
  line=$(poll) || line=""
  state=$(printf '%s' "$line" | cut -f1)
  sha=$(printf '%s' "$line" | cut -f2)
  title=$(printf '%s' "$line" | cut -f3)

  if [ "$state" = "failure" ] && { [ "$prev_state" != "failure" ] || [ "$prev_sha" != "$sha" ]; }; then
    echo "MASTER RED at $sha - $title - lanes cannot merge, stop dispatching and fix this first"
    prev_state=$state; prev_sha=$sha
  elif [ "$state" = "success" ] && [ "$prev_state" = "failure" ]; then
    echo "MASTER GREEN again at $sha - $title"
    prev_state=$state; prev_sha=$sha
  elif [ "$state" = "success" ]; then
    prev_state=$state; prev_sha=$sha
  fi
  sleep "$interval"
done
