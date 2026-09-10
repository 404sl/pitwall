#!/bin/bash

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
lane-running.sh <issue-id> [--quiet] [--stale-minutes N]
lane-running.sh --any [--quiet] [--stale-minutes N]

Is a lane for this issue running RIGHT NOW? Answered from the only signal that can
say so: the harness creates a task output file empty at dispatch and writes it when
the run ends, and the session transcript ties that task to the workflow whose
journal labels its phases with the issue id.

A workflow is attributed by the SCRIPT it was dispatched from, which the transcript
records beside the task id, because the scripts do not label alike. task.js labels
every phase with the issue id, so a task.js journal carrying labels that are not
this id belongs to another issue. rework.js labels resolve:<id>#<pr>, so the same
holds for it once EVERY label in its journal carries an id; one still carrying the
old id-less resolve:#<pr> is UNKNOWN. land.js and land-train.js carry no issue id
at all and are no issue's lane - which is a statement about attribution and not
about the worktree: a lander rebases inside a lane's worktree when it finds one,
so kill-lane.sh checks that worktree for a rebase in progress separately from this
verdict. Everything else is UNKNOWN rather than guessed.

--any asks the same question of the whole workspace - is ANY lane still running -
which is what a supervisor needs before it starts a train. It reads the same scan
and never the slot registry: a claim proves a lane started, is missed at both ends,
and a lane dispatched by hand never reaches it at all. Any in-flight workflow whose
journal labels a phase is a lane, whichever issue it belongs to; a lander is not.

A RUNNING whose journal has stopped being written to is STILL RUNNING, and the line
says how long it has been silent. A lane waiting on a CI run writes nothing for half an
hour at a time, so silence is not death and the verdict must not soften - but a task
dispatched and then orphaned never writes its output file either, and that reads RUNNING
for as long as the file sits there. The age is what lets a caller say so out loud instead
of waiting on it forever. --stale-minutes sets the window, default 20, which is the one
lanes.sh uses under the same name.

  RUNNING       a task for this issue is in flight - exit 0
  NOT-RUNNING   nothing in flight is this issue's - exit 1
  UNKNOWN       the scan could not establish it - exit 2, never read as dead
                exit 3 means the workspace itself could not be resolved
                exit 6 means the arguments were wrong, which answers nothing

A slot claim, a lane lock, a worktree and TaskList do not answer this question.
TaskList has never listed a workflow at all, so its empty result says nothing.
EOF
}

ID=""
QUIET=0
ANY=0
STALE=20
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    --any) ANY=1; shift ;;
    --stale-minutes) STALE="${2:-20}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 6 ;;
    *)
      [ -n "$ID" ] && { echo "one issue id at a time, got: $ID $1" >&2; exit 6; }
      ID="$1"; shift ;;
  esac
done
if [ "$ANY" = 1 ]; then
  [ -z "$ID" ] || { echo "--any asks about every lane, so it takes no issue id, got: $ID" >&2; exit 6; }
  WHO="any lane"
else
  [ -n "$ID" ] || { usage >&2; exit 6; }
  WHO="$ID"
fi

ROOT="${DEVLOOP_ROOT:-$(bash "$HERE/config.sh" root 2>/dev/null)}"
if [ -z "$ROOT" ]; then
  echo "lane-running.sh: no workspace resolved - refusing to guess." >&2
  echo "                 An answer about another workspace's lanes is worse than no answer." >&2
  exit 3
fi

SLUG="$(printf '%s' "$ROOT" | sed 's|/|-|g')"
WF="${DEVLOOP_WF:-$HOME/.claude/projects/$SLUG}"

IDRE=""
MENTIONS=""
LABELLED=""
if [ "$ANY" = 0 ]; then
  IDRE="$(printf '%s' "$ID" | sed 's/[][\\.*^$(){}?+|/]/\\&/g')"
  MENTIONS="(^|[^A-Za-z0-9._-])${IDRE}([^A-Za-z0-9._-]|\$)"
  LABELLED="\"label\":\"([^\"]*:)?${IDRE}(#[0-9]+)?\""
fi

task_dirs() {
  if [ -n "${DEVLOOP_TASKS:-}" ]; then
    printf '%s\n' ${DEVLOOP_TASKS}
    return
  fi
  local d real seen=""
  for d in /tmp/claude-*/"$SLUG"/*/tasks /private/tmp/claude-*/"$SLUG"/*/tasks; do
    [ -d "$d" ] || continue
    real="$(cd "$d" && pwd -P)" || continue
    case " $seen " in *" $real "*) continue ;; esac
    seen="$seen $real"
    printf '%s\n' "$real"
  done
}

labels_in() {
  grep -oE '"label":"[^"]*"' "$1" 2>/dev/null | sed 's/^"label":"//; s/"$//'
}

rework_labels_another_issue() {
  local labels
  labels="$(labels_in "$1")"
  [ -n "$labels" ] || return 1
  printf '%s\n' "$labels" | grep -qvE '^(resolve|handoff):[A-Za-z0-9._-]+(#[0-9]+)+$' && return 1
  return 0
}

lane_ids() {
  local ids=""
  if [ -n "$1" ]; then
    ids="$(grep -oE '"label":"[^"]*"' "$1" 2>/dev/null |
           sed 's/^"label":"//; s/"$//; s/^[^:]*://; s/#[0-9]*$//' |
           grep -E '^[A-Za-z0-9]+-[A-Za-z0-9._-]+$' | sort -u | tr '\n' ' ')"
    ids="${ids% }"
  fi
  printf '%s' "${ids:-no id in its labels}"
}

journal_for() {
  local run="$1" j
  for j in "$WF"/*/subagents/workflows/"$run"/journal.jsonl "$WF"/"$run"/journal.jsonl; do
    [ -f "$j" ] && { printf '%s' "$j"; return 0; }
  done
  return 1
}

NOW=$(date +%s)

mtime_of() {
  stat -c %Y "$1" 2>/dev/null && return 0
  stat -f %m "$1" 2>/dev/null
}

silent_minutes() {
  local journal="$1" dir newest=0 m f
  [ -n "$journal" ] || return 1
  dir="$(dirname "$journal")"
  for f in "$dir"/*.jsonl; do
    [ -f "$f" ] || continue
    m="$(mtime_of "$f")"
    case "$m" in ''|*[!0-9]*) continue ;; esac
    [ "$m" -gt "$newest" ] && newest="$m"
  done
  [ "$newest" = 0 ] && return 1
  printf '%s' $(( (NOW - newest) / 60 ))
}

scanned=0
finished=0
written=""
empty=""

for dir in $(task_dirs); do
  [ -d "$dir" ] || continue
  scanned=$((scanned + 1))
  for f in "$dir"/*.output; do
    [ -e "$f" ] || continue
    task="$(basename "$f" .output)"
    if [ -s "$f" ]; then
      if [ "$ANY" = 0 ] && grep -Eq "$MENTIONS" "$f" 2>/dev/null; then
        finished=$((finished + 1))
      fi
      case " $written " in *" $task "*) ;; *) written="$written $task" ;; esac
      continue
    fi
    case "$task" in w*) ;; *) continue ;; esac
    case " $empty " in *" $task "*) ;; *) empty="$empty $task" ;; esac
  done
done

inflight=""
for task in $empty; do
  case " $written " in *" $task "*) continue ;; esac
  inflight="$inflight $task"
done

records=""
if [ -n "$inflight" ]; then
  alt="$(printf '%s' "${inflight# }" | sed 's/ /|/g')"
  records="$(grep -rlE "\"taskId\":\"(${alt})\"" "$WF" 2>/dev/null |
             while IFS= read -r file; do
               [ -f "$file" ] && grep -hoE '\{"status":"async_launched"[^{}]*\}' "$file" 2>/dev/null
             done |
             grep -E "\"taskId\":\"(${alt})\"" |
             awk '{
               task = ""; run = ""; script = "-"
               if (match($0, /"taskId":"[^"]+"/)) task = substr($0, RSTART + 10, RLENGTH - 11)
               if (match($0, /"runId":"[^"]+"/)) run = substr($0, RSTART + 9, RLENGTH - 10)
               if (match($0, /"scriptPath":"[^"]+"/)) {
                 script = substr($0, RSTART + 14, RLENGTH - 15)
                 sub(/.*\//, "", script)
               }
               if (task != "" && run != "") print task, run, script
             }' | sort -u)"
fi

running=""
unaccounted=""
elsewhere=0
landers=0

for task in $inflight; do
  runs="$(printf '%s\n' "$records" | awk -v t="$task" '$1 == t { print $2 }' | sort -u)"
  if [ "$(printf '%s\n' "$runs" | grep -c .)" != "1" ]; then
    unaccounted="$unaccounted $task"
    continue
  fi
  script="$(printf '%s\n' "$records" | awk -v t="$task" '$1 == t { print $3 }' | sort -u | head -1)"
  journal="$(journal_for "$runs")" || journal=""

  if [ "$ANY" = 1 ]; then
    if [ "$script" = "land.js" ] || [ "$script" = "land-train.js" ]; then
      landers=$((landers + 1))
    elif [ -n "$journal" ] && grep -q '"label":"' "$journal" 2>/dev/null; then
      running="$running ${task}:${runs}"
    else
      unaccounted="$unaccounted $task"
    fi
    continue
  fi

  if [ -n "$journal" ] && grep -Eq "$LABELLED" "$journal" 2>/dev/null; then
    running="$running ${task}:${runs}"
  elif [ "$script" = "land.js" ] || [ "$script" = "land-train.js" ]; then
    landers=$((landers + 1))
  elif [ "$script" = "task.js" ] && [ -n "$journal" ] && grep -q '"label":"' "$journal" 2>/dev/null; then
    elsewhere=$((elsewhere + 1))
  elif [ "$script" = "rework.js" ] && [ -n "$journal" ] && rework_labels_another_issue "$journal"; then
    elsewhere=$((elsewhere + 1))
  else
    unaccounted="$unaccounted $task"
  fi
done

if [ -n "$running" ]; then
  if [ "$QUIET" = 1 ]; then echo "RUNNING"; exit 0; fi
  silent=0
  for pair in $running; do
    journal="$(journal_for "${pair#*:}")" || journal=""
    age="$(silent_minutes "$journal")" || age=""
    silence=""
    if [ -n "$age" ] && [ "$age" -gt "$STALE" ]; then
      silence=", journal silent ${age}m"
      silent=1
    fi
    if [ "$ANY" = 1 ]; then
      echo "RUNNING  $(lane_ids "$journal") - task ${pair%%:*}, workflow ${pair#*:}, result not written${silence}."
    else
      echo "RUNNING  ${ID} - task ${pair%%:*}, workflow ${pair#*:}, result not written${silence}."
    fi
  done
  if [ "$silent" = 1 ]; then
    echo "  A journal that has stopped moving is not a lane that has stopped - one waiting on a CI"
    echo "  run writes nothing for half an hour - so the verdict stays RUNNING. It can also be a"
    echo "  task that was dispatched and orphaned, which reads this way forever. Read it, and only"
    echo "  then kill-lane.sh it."
  fi
  if [ "$ANY" = 1 ]; then
    echo "  A lane still writing is a passenger a train started now would leave behind."
  else
    echo "  Stop it with TaskStop before cleaning up after it."
  fi
  exit 0
fi

if [ "$scanned" = "0" ]; then
  if [ "$QUIET" = 1 ]; then echo "UNKNOWN"; exit 2; fi
  echo "UNKNOWN  ${WHO} - no task directory for this workspace, so nothing to read."
  echo "  Not evidence the lane is dead. Check its pull request and its worktree before acting."
  exit 2
fi

if [ -n "$unaccounted" ]; then
  set -- $unaccounted
  if [ "$QUIET" = 1 ]; then echo "UNKNOWN"; exit 2; fi
  echo "UNKNOWN  ${WHO} - $# task(s) in flight cannot be attributed:$unaccounted"
  if [ "$ANY" = 1 ]; then
    echo "  One of them may be a lane. Not evidence it is dead, and not 'no lanes running'."
  else
    echo "  One of them may be this lane. Not evidence it is dead."
  fi
  exit 2
fi

if [ "$QUIET" = 1 ]; then echo "NOT-RUNNING"; exit 1; fi
if [ "$ANY" = 1 ]; then
  echo "NOT-RUNNING  no lane is in flight - ${landers} lander(s) in flight, ${scanned} task directory(ies) read."
  exit 1
fi
echo "NOT-RUNNING  ${ID} - ${finished} finished run(s) name it, ${elsewhere} lane(s) in flight belong to other issues, ${landers} lander(s) in flight."
exit 1
