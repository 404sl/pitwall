#!/bin/bash

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
lane-running.sh <issue-id> [--quiet]

Is a lane for this issue running RIGHT NOW? Answered from the only signal that can
say so: the harness creates a task output file empty at dispatch and writes it when
the run ends, and the session transcript ties that task to the workflow whose
journal labels its phases with the issue id.

A workflow is attributed by the SCRIPT it was dispatched from, which the transcript
records beside the task id, because the scripts do not label alike. task.js labels
every phase with the issue id, so a task.js journal carrying labels that are not
this id belongs to another issue. land.js and land-train.js carry no issue id at
all and are never any issue's lane. Everything else is UNKNOWN rather than guessed.

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
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 6 ;;
    *)
      [ -n "$ID" ] && { echo "one issue id at a time, got: $ID $1" >&2; exit 6; }
      ID="$1"; shift ;;
  esac
done
[ -n "$ID" ] || { usage >&2; exit 6; }

ROOT="${DEVLOOP_ROOT:-$(bash "$HERE/config.sh" root 2>/dev/null)}"
if [ -z "$ROOT" ]; then
  echo "lane-running.sh: no workspace resolved - refusing to guess." >&2
  echo "                 An answer about another workspace's lanes is worse than no answer." >&2
  exit 3
fi

SLUG="$(printf '%s' "$ROOT" | sed 's|/|-|g')"
WF="${DEVLOOP_WF:-$HOME/.claude/projects/$SLUG}"

IDRE="$(printf '%s' "$ID" | sed 's/[][\\.*^$(){}?+|/]/\\&/g')"
MENTIONS="(^|[^A-Za-z0-9._-])${IDRE}([^A-Za-z0-9._-]|\$)"
LABELLED="\"label\":\"([^\"]*:)?${IDRE}(#[0-9]+)?\""

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

journal_for() {
  local run="$1" j
  for j in "$WF"/*/subagents/workflows/"$run"/journal.jsonl "$WF"/"$run"/journal.jsonl; do
    [ -f "$j" ] && { printf '%s' "$j"; return 0; }
  done
  return 1
}

scanned=0
finished=0
inflight=""

for dir in $(task_dirs); do
  [ -d "$dir" ] || continue
  scanned=$((scanned + 1))
  for f in "$dir"/*.output; do
    [ -e "$f" ] || continue
    if [ -s "$f" ]; then
      grep -Eq "$MENTIONS" "$f" 2>/dev/null && finished=$((finished + 1))
      continue
    fi
    task="$(basename "$f" .output)"
    case "$task" in w*) ;; *) continue ;; esac
    case " $inflight " in *" $task "*) continue ;; esac
    inflight="$inflight $task"
  done
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

  if [ -n "$journal" ] && grep -Eq "$LABELLED" "$journal" 2>/dev/null; then
    running="$running ${task}:${runs}"
  elif [ "$script" = "land.js" ] || [ "$script" = "land-train.js" ]; then
    landers=$((landers + 1))
  elif [ "$script" = "task.js" ] && [ -n "$journal" ] && grep -q '"label":"' "$journal" 2>/dev/null; then
    elsewhere=$((elsewhere + 1))
  else
    unaccounted="$unaccounted $task"
  fi
done

if [ -n "$running" ]; then
  if [ "$QUIET" = 1 ]; then echo "RUNNING"; exit 0; fi
  for pair in $running; do
    echo "RUNNING  ${ID} - task ${pair%%:*}, workflow ${pair#*:}, result not written."
  done
  echo "  Stop it with TaskStop before cleaning up after it."
  exit 0
fi

if [ "$scanned" = "0" ]; then
  if [ "$QUIET" = 1 ]; then echo "UNKNOWN"; exit 2; fi
  echo "UNKNOWN  ${ID} - no task directory for this workspace, so nothing to read."
  echo "  Not evidence the lane is dead. Check its pull request and its worktree before acting."
  exit 2
fi

if [ -n "$unaccounted" ]; then
  set -- $unaccounted
  if [ "$QUIET" = 1 ]; then echo "UNKNOWN"; exit 2; fi
  echo "UNKNOWN  ${ID} - $# task(s) in flight cannot be attributed:$unaccounted"
  echo "  One of them may be this lane. Not evidence it is dead."
  exit 2
fi

if [ "$QUIET" = 1 ]; then echo "NOT-RUNNING"; exit 1; fi
echo "NOT-RUNNING  ${ID} - ${finished} finished run(s) name it, ${elsewhere} lane(s) in flight belong to other issues, ${landers} lander(s) in flight."
exit 1
