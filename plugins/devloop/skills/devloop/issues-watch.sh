#!/usr/bin/env bash
# New issues on this workspace's repositories, once each.
#
# WHY A SEPARATE WATCHER. watch.sh answers "what should the supervisor do about the queue".
# This answers "has somebody outside the queue said something", which is a different question
# with a different safety story: the repositories are public, so anyone can file an issue, and
# an issue is somebody's report rather than a specification.
#
# WHAT IT DELIBERATELY DOES NOT DO: decide anything. It reports new issues and who filed them.
# Whether an issue becomes work, and whether that work may run unattended, is a judgement and
# belongs to a session that can read the thing. A shell script that triaged would be a shell
# script guessing.
#
#   issues-watch.sh            print issues not seen before, and mark them seen
#   issues-watch.sh --peek     print them, change nothing
#   issues-watch.sh --loop N   poll every N seconds (default 300), print ONLY on change
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HERE/config.sh"
ROOT="${DEVLOOP_ROOT:-$(bash "$CFG" root 2>/dev/null)}"
[ -n "$ROOT" ] || { echo "issues-watch.sh: no workspace resolved - refusing to guess." >&2; exit 6; }

PEEK=0; LOOP=0; EVERY=300
while [ $# -gt 0 ]; do
  case "$1" in
    --peek) PEEK=1; shift ;;
    --loop) LOOP=1; EVERY="${2:-300}"; [ "${2:-}" = "" ] || shift; shift ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

# THE HIGH-WATER MARK IS THE ISSUE NUMBER, NOT A TIMESTAMP.
#
# A date filter is a signal that can be subtly wrong and silently report nothing: `created:>`
# and `created:>=` differ by a whole day's issues, and the wrong one returns an empty list that
# looks exactly like quiet. An issue number only ever increases, so "greater than the last one
# seen" cannot be subtly wrong - it is either right or it fails to fetch.
STATE="${DEVLOOP_ISSUE_STATE:-$ROOT/.autofix-run/.issues-seen}"
mkdir -p "$(dirname "$STATE")" 2>/dev/null

slugs() { bash "$CFG" 2>/dev/null | python3 -c '
import json,sys
try: cfg = json.load(sys.stdin)
except Exception: sys.exit(1)
for name, r in (cfg.get("repos") or {}).items():
    if (r or {}).get("slug"): print(r["slug"])
'; }

# Logins whose issues may be treated as ours. ANYTHING ELSE IS SOMEBODY ELSE'S REPORT and this
# says so, every time, rather than leaving the reader to infer it from a name they recognise.
trusted() { bash "$CFG" 2>/dev/null | python3 -c '
import json,sys
try: cfg = json.load(sys.stdin)
except Exception: sys.exit(1)
for login in (cfg.get("trustedIssueAuthors") or []): print(login)
'; }

report_once() {
  local changed=0 slug last now
  local TRUST; TRUST="$(trusted)"
  for slug in $(slugs); do
    # A FAILED FETCH IS NOT AN EMPTY ONE. gh returns nothing for a network failure, an expired
    # token and a repository with no issues alike; only the last means "nothing new".
    local json; json="$(gh issue list --repo "$slug" --state all --limit 30 \
                          --json number,title,author,url 2>/dev/null)"
    if [ -z "$json" ]; then
      echo "ISSUES $slug: COULD NOT READ - not the same as no new issues. Check gh auth."
      changed=1; continue
    fi
    last="$(grep "^$slug " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')"
    [ -n "$last" ] || last=0
    now="$last"
    while IFS=$'\t' read -r num title author url; do
      [ -n "$num" ] || continue
      [ "$num" -gt "$last" ] 2>/dev/null || continue
      [ "$num" -gt "$now" ] && now="$num"
      # The association comes from the REST endpoint; `gh issue list --json` does not carry it.
      local assoc; assoc="$(gh api "repos/$slug/issues/$num" --jq '.author_association' 2>/dev/null)"
      [ -n "$assoc" ] || assoc="UNKNOWN"
      local verdict="OUTSIDE - somebody else's report. Park it; a person decides if it is work."
      if printf '%s\n' "$TRUST" | grep -qx "$author"; then
        verdict="ours - $author is a configured author"
      fi
      echo "ISSUE $slug#$num  by $author ($assoc)"
      echo "  $title"
      echo "  $url"
      echo "  $verdict"
      changed=1
    done < <(printf '%s' "$json" | python3 -c '
import json,sys
for i in json.load(sys.stdin):
    print("\t".join([str(i["number"]), i["title"].replace("\t"," "), (i.get("author") or {}).get("login","?"), i["url"]]))
' 2>/dev/null)
    if [ "$PEEK" = "0" ] && [ "$now" != "$last" ]; then
      grep -v "^$slug " "$STATE" 2>/dev/null > "$STATE.tmp"
      echo "$slug $now" >> "$STATE.tmp"
      mv "$STATE.tmp" "$STATE"
    fi
  done
  return $((1 - changed))
}

if [ "$LOOP" = "0" ]; then
  report_once || true
  exit 0
fi
while true; do
  report_once || true
  sleep "$EVERY"
done
