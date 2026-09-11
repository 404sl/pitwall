#!/usr/bin/env bash
# Emit an event when the devloop queue gains work, or when work is ready to land.
#
# WHY A WATCHER AND NOT A POLL. The queue spends long stretches empty and then refills in
# bursts - a lane files follow-ups, a train closes a parent and unblocks its children, the
# owner answers something that was parked. Re-reading it by hand costs a round trip every
# time and mostly reports "nothing", which is how a genuinely idle pipeline and a stuck one
# come to look identical.
#
# WHAT IT REPORTS, which is everything a supervisor would act on:
#   NEW WORK      an id became dispatchable that was not dispatchable before
#   READY TO LAND pull requests carry lane-verified and no lane is still running
#   STUCK         triage-scan found an issue in a state nothing will move it out of
# It says nothing while the queue is empty and quiet, so silence here means idle, not blind.
set -u

root="the workspace root"
interval=300
ack_file=""
skill="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --root)     root=$2;     shift 2 ;;
    --interval) interval=$2; shift 2 ;;
    --ack-file) ack_file=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
cd "$root" || { echo "cannot enter $root" >&2; exit 2; }
PFX="$(bash "$skill/config.sh" lockPrefix 2>/dev/null || echo devloop)"
[ -n "$ack_file" ] || ack_file="$root/.devloop-triage-ack"

# Ids currently offered as ready work. dispatchable.sh prints its "nothing dispatchable"
# notice in parentheses, which no id matches, so an empty result needs no special case.
dispatchable_ids() {
  bash "$skill/dispatchable.sh" 2>/dev/null | grep -oE '^sr-[a-z0-9.]+' | sort
}

# Pull requests a lane has finished with, across every repository that has any.
#
# THE SLUGS COME FROM THE WORKSPACE CONFIG, not from a pattern. This used to loop over the
# literal names site/ext/integration/docs and build "404sl/one workspace-$r", so running it
# from any other workspace reported THIS project's queue as though it were that one's - the same
# shape as watch.sh answering about the wrong project, found across five other scripts on
# 2026-09-09. A monitor that answers confidently about the wrong workspace is worse than one
# that says nothing.
repo_slugs() {
  bash "$skill/config.sh" --land 2>/dev/null | python3 -c "
import json,sys
try: cfg = json.load(sys.stdin)
except Exception: raise SystemExit
for name, r in (cfg.get('repos') or {}).items():
    slug = (r or {}).get('slug')
    if slug: print(f'{name} {slug}')
" 2>/dev/null
}

verified_prs() {
  repo_slugs | while read -r name slug; do
    [ -n "${slug:-}" ] || continue
    gh pr list --repo "$slug" --label lane-verified --state open \
       --json number --template "{{range .}}$name#{{.number}} {{end}}" 2>/dev/null
  done
}

lanes_busy() {
  local verdict
  verdict="$(bash "$skill/lane-running.sh" --any --quiet 2>/dev/null)"
  case "$?" in
    1) echo 0 ;;
    0) echo "${verdict:-RUNNING}" ;;
    *) echo "${verdict:-UNKNOWN}" ;;
  esac
}

silent_lanes() {
  bash "$skill/lane-running.sh" --any 2>/dev/null | awk '
    /^RUNNING  / {
      rest = substr($0, 10)
      ids = rest
      sub(/ - task .*$/, "", ids)
      task = ""
      if (match(rest, /task [^,]+/)) task = substr(rest, RSTART + 5, RLENGTH - 5)
      key = (ids == "no id in its labels") ? "task " task : ids
      if (!(key in runs)) { order[++n] = key; runs[key] = 0 }
      runs[key]++
      if (match($0, /journal silent [0-9]+m/)) {
        age = substr($0, RSTART + 15, RLENGTH - 16) + 0
        if (!(key in quiet) || age < quiet[key]) { quiet[key] = age; newest[key] = rest }
      } else {
        writing[key] = 1
      }
    }
    END {
      for (i = 1; i <= n; i++) {
        key = order[i]
        if (key in writing) continue
        if (!(key in newest)) continue
        text = newest[key]
        sub(/\.$/, "", text)
        if (runs[key] > 1) text = text ", newest of " runs[key] " runs for this issue"
        print "  " text
      }
    }
  '
}

# A lander already running holds the merge lock. Announcing "ready to land" then is not just
# noise, it invites a second train onto the same repository - which is the one thing the lock
# exists to prevent.
lander_running() {
  [ -d "/tmp/${PFX}-merge.lock" ]
}

# The two site environments must serve the same revision. A train deploys staging first, so any
# train that stops between the two leaves staging ahead with NOTHING reporting an error - the
# staging deploy really did succeed. The extension has an environment switcher, so a change live
# in only one of them is live in neither.
#
# THIS IS ALSO WHAT A HEALTHY TRAIN LOOKS LIKE MID-DEPLOY, which is why the alarm is gated on the
# merge lock being free. That gate is not sufficient on its own: on 2026-09-06 a supervisor saw
# this exact split, concluded the train was dead, cleared the lock and hand-deployed production
# while the train's own deploy was still in flight - two production releases 101 seconds apart.
# The alarm says LOOK, not ACT. Confirm nothing is deploying before deploying anything.
# THE HOSTS COME FROM THE CONFIG, and the check is skipped when they are not there rather than
# defaulting. These are LIVE PRODUCTION endpoints: hardcoded, this reported one workspace's
# deployed revision to whatever workspace ran it, which is a wrong answer about what is live -
# the worst kind for a monitor, because a supervisor acts on it. Set envHosts.staging and
# envHosts.production in the workspace config to enable this check.
env_hosts() {
  bash "$skill/config.sh" envHosts 2>/dev/null | python3 -c "
import json,sys
raw = sys.stdin.read().strip()
if not raw: raise SystemExit
try: h = json.loads(raw)
except Exception: raise SystemExit
if isinstance(h, dict) and h.get('staging') and h.get('production'):
    print(h['staging']); print(h['production'])
" 2>/dev/null
}

env_drift() {
  hosts=$(env_hosts)
  [ -n "$hosts" ] || return 0   # not configured: this workspace has no two-environment check
  staging_host=$(printf '%s\n' "$hosts" | sed -n 1p)
  production_host=$(printf '%s\n' "$hosts" | sed -n 2p)
  s=$(curl -s -m 15 "https://${staging_host}/health"    | sed -n 's/.*"git_revision":"\([0-9a-f]*\)".*/\1/p')
  p=$(curl -s -m 15 "https://${production_host}/health" | sed -n 's/.*"git_revision":"\([0-9a-f]*\)".*/\1/p')
  # An unreachable host is not drift - say nothing rather than crying wolf on a network blip.
  [ -n "$s" ] && [ -n "$p" ] || return 0
  [ "$s" = "$p" ] && return 0
  echo "staging=${s:0:8} production=${p:0:8}"
}

land_gate() {
  local ready="$1" busy="$2" silent
  if [ -z "${ready// /}" ]; then prev_ready=""; prev_blind=""; prev_silent=""; return; fi
  lander_running && return
  if [ "$busy" = "0" ]; then
    [ "$ready" = "$prev_ready" ] && return
    echo "QUEUE: ready to land, no lanes running - $ready"
    prev_ready=$ready
    return
  fi
  if [ "$busy" = "UNKNOWN" ]; then
    [ "$ready" = "$prev_blind" ] && return
    echo "QUEUE: ready to land, and whether a lane is running cannot be established - $ready"
    echo "  lane-running.sh --any answered UNKNOWN, which is not 'no lanes running'. Read it"
    echo "  before starting a train - a train over a live lane moves master underneath it."
    prev_blind=$ready
    return
  fi
  [ "$ready" = "$prev_silent" ] && return
  silent="$(silent_lanes)"
  [ -n "$silent" ] || return
  echo "QUEUE: ready to land, and the lane holding the gate has gone silent - $ready"
  printf '%s\n' "$silent"
  echo "  Still RUNNING, and the gate stays shut - a lane waiting on a CI run writes nothing for"
  echo "  half an hour at a time. But a task orphaned at dispatch reads the same way forever, so"
  echo "  read the lane before the next train: kill-lane.sh --slot N --id <id> if it is dead."
  echo "  Each run named is the newest writer for its issue. An earlier dispatch for the same issue"
  echo "  says nothing about it and was not judged - check the same run this did, not the oldest."
  prev_silent=$ready
}

seen=""          # ids already announced, so a queue that stays full is not re-announced
prev_ready=""
prev_blind=""
prev_silent=""
prev_stuck=""
prev_drift=""

while true; do
  ids=$(dispatchable_ids)

  fresh=""
  for id in $ids; do
    case " $seen " in *" $id "*) ;; *) fresh="$fresh $id" ;; esac
  done
  if [ -n "${fresh// /}" ]; then
    echo "QUEUE: new work ready to dispatch -$fresh"
    seen="$seen$fresh"
  fi

  # Ready to land is only actionable once the lanes that would add passengers are done,
  # otherwise it fires mid-run and invites a train that leaves half the batch behind.
  ready=$(verified_prs | tr -s ' ')
  busy=$(lanes_busy)
  land_gate "$ready" "$busy"

  # Never while a train is mid-deploy: it holds the lock and staging is legitimately ahead.
  if ! lander_running; then
    drift=$(env_drift)
    if [ -n "$drift" ] && [ "$drift" != "$prev_drift" ]; then
      echo "QUEUE: environments disagree, no train running - $drift"
      echo "  a train may still be deploying - check for mina/ssh processes and the server release"
      echo "  list BEFORE deploying anything; only then catch the laggard up with deploy-one.sh"
      prev_drift=$drift
    fi
    [ -z "$drift" ] && prev_drift=""
  fi

  # Triage reports structural patterns, not judgements, so some findings are permanent and
  # correct-as-they-are: an umbrella held open by a dependency, a question whose acceptance
  # criteria read like an answer. Those were adjudicated once and recorded on the tickets.
  # Repeating them forever would bury the next real one, so ids in the ack file are counted
  # and named but do not raise an event. Nothing is hidden - the suppressed ids are printed
  # alongside whatever is new.
  # PASS THE ROOT. Without it triage-scan.sh resolves its own, which is a different
  # workspace whenever this watcher was pointed at one with --root.
  stuck=$(DEVLOOP_ROOT="$root" bash "$skill/triage-scan.sh" --quiet 2>/dev/null)
  # triage's own LANDER IDLE check says "a labelled PR is waiting and nobody holds the merge
  # lock". True, but it does not know whether lanes are still running, and while they are the
  # right move is to wait for them rather than run a train per passenger. The READY TO LAND
  # event above already reports this case with that gate applied, so drop the duplicate while
  # lanes are working and let it through the moment they are not.
  # triage's LANDER IDLE check is dropped unconditionally, not gated. The READY TO LAND event
  # above tests the same thing with both gates applied - lanes idle AND no lander holding the
  # merge lock - and re-arms itself whenever a train drains the queue, so nothing is lost. Gating
  # it was not enough: the scan polls on its own clock and kept landing in the seconds between a
  # train being launched and that train taking the lock, reporting "nobody is landing" about a
  # train that was already running.
  stuck=$(printf '%s\n' "$stuck" | sed '/LANDER IDLE/,$d')
  [ -n "$(printf '%s' "$stuck" | grep -oE 'sr-[a-z0-9.]+')" ] || stuck=""
  if [ -n "$stuck" ]; then
    acked=""
    [ -f "$ack_file" ] && acked=$(grep -oE '^(sr-[a-z0-9.]+|[a-z]+#[0-9]+)' "$ack_file" | tr '\n' ' ')
    new_ids=""
    for id in $(printf '%s\n' "$stuck" | grep -oE 'sr-[a-z0-9.]+|[a-z]+#[0-9]+' | sort -u); do
      case " $acked " in *" $id "*) ;; *) new_ids="$new_ids $id" ;; esac
    done
    if [ -n "${new_ids// /}" ] && [ "$new_ids" != "$prev_stuck" ]; then
      echo "QUEUE: triage found something stuck -$new_ids"
      # One finding line can name several ids (LANDER IDLE lists every waiting PR), so grepping
      # per id prints that line once per id. Collect then dedupe, or a six-PR queue reports the
      # same sentence six times and the event becomes unreadable.
      for id in $new_ids; do printf '%s\n' "$stuck" | grep -F "$id"; done | sort -u | head -12
      n_ack=$(printf '%s' "$acked" | wc -w | tr -d ' ')
      [ "$n_ack" -gt 0 ] && echo "  ($n_ack known finding(s) suppressed, already adjudicated: $acked)"
      prev_stuck=$new_ids
    fi
  else
    prev_stuck=""
  fi

  sleep "$interval"
done
