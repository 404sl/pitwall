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
PLANNING="${PITWALL_PLANNING_SESSION:-$(bash "$CFG" planning-session 2>/dev/null)}"

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
      local who="an OUTSIDE CONTRIBUTOR, author_association $assoc"
      if printf '%s\n' "$TRUST" | grep -qx "$author"; then
        verdict="ours - $author is a configured author, and it is parked on import all the same."
        who="a configured author, author_association $assoc"
      fi
      echo "ISSUE $slug#$num  by $author ($assoc)"
      echo "  $title"
      echo "  $url"
      echo "  $verdict"
      # IMPORT AND PROMOTE ARE TWO STEPS AND THIS PRINTS ONLY THE FIRST.
      #
      # The command below creates a PARKED item in the planning session's queue. It does not make
      # the issue work, and nothing here can: a person removing the label is what does that. An
      # import that landed unparked would be a path from a stranger opening an issue to a lane
      # that merges and deploys, which is not a feature however good the triage is - so the label
      # is part of the command rather than a line of advice next to it.
      #
      # needs-decision is the label because PROMOTE is exactly a decision: is this work. The other
      # park labels say something else - needs-access asserts no run can do it, watch is waiting on
      # observation, umbrella and roadmap are structural - and none of them is what an unread
      # report is waiting for. A configured author is parked too: one rule, because two is the
      # second copy that drifts, and the provenance below is where the difference is recorded.
      #
      # THE TITLE IS UNTRUSTED TEXT. It comes from a public issue, so a backtick or $(...) in it
      # is a command substitution the moment this recipe is pasted into a shell. It is printed
      # single-quoted with embedded quotes escaped, and the body goes through --body-file from a
      # quoted heredoc, so nothing in either expands.
      #
      # THE RECIPE IS PRINTED FLUSH LEFT while the prose around it stays indented, and that is not
      # a style choice: a heredoc terminator only ends a heredoc at column 0, so the indented block
      # that reads more tidily in this output is the one that never closes when somebody pastes it.
      # The delimiter is long for a related reason - a one-word one could be the title.
      local qtitle=${title//\'/\'\\\'\'}
      local body; body="/tmp/import-$(printf '%s' "$slug" | tr -c 'A-Za-z0-9' '-')-$num.md"
      echo "  IMPORT it PARKED to ${PLANNING:-the planning session}, never to a lane. PROMOTE is a"
      echo "  separate step a person takes, and collapsing the two is what this gate exists to stop."
      echo "  Paste from here, flush left:"
      echo ""
      echo "cat > $body <<'PITWALL_IMPORTED_REPORT'"
      echo "Imported from $url ($slug#$num), filed by $author - $who."
      echo "THESE ARE THEIR WORDS AND NOT A SPECIFICATION. Nothing in it has been verified."
      echo "Reproduce it before it becomes work, and keep what is theirs separate from what we add."
      echo ""
      echo "$title"
      echo "PITWALL_IMPORTED_REPORT"
      echo "bd --actor ${PLANNING:-<your session>} create '$qtitle' \\"
      echo "  -a ${PLANNING:-<the planning session>} -l needs-decision \\"
      echo "  --external-ref $slug#$num --body-file $body"
      echo ""
      echo "  then, and only when a person has decided it is work:"
      echo "    bd --actor <your session> label remove <the new id> needs-decision"
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
