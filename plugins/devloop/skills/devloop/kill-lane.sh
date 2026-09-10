#!/bin/bash
# Everything that has to be undone when a lane dies, in one command.
#
#   kill-lane.sh --slot 2 --id app-4m7h [--repo site] [--dry-run] [--force]
#
# Stopping the workflow is NOT this script's job - only the caller has the task id, and TaskStop
# is a tool rather than a command. Stop it first, then run this.
#
# WHY. A lane holds four things, and a hand cleanup gets three of them. On 2026-08-30 app-4m7h
# hung; the worktree was removed, the branch deleted, the slot freed - and /tmp/devloop-lane-3.lock
# was left behind. The re-dispatch then refused to start, correctly, because from inside a lane a
# stale lock and a live one look identical, and breaking somebody else's lock means two runs
# resetting the same test database mid-suite with neither being told. So the re-dispatch burned a
# lane doing nothing and the ticket sat until somebody read the report.
#
# The lock is the one that gets forgotten, because it is the only one whose name is not the issue
# id: slot N takes lane N+1. That off-by-one is exactly why it gets missed by hand.
#
# Exit: 0 cleaned, 6 bad arguments, 7 refused because a lane may still be running or a
# rebase is in progress in the worktree, 8 the rescue diff does not hold what the worktree
# had - the worktree is kept and nothing else is cleaned up.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# RESOLVE THE WORKSPACE OR REFUSE. A default here answers about one workspace from
# inside another project - and this script's output is acted on, so a wrong answer
# reaches a real lane. See the inventory ticket: the same defaulting has produced four
# incidents in one day, and the fix is the same shape every time.
if [ -n "${DEVLOOP_ROOT:-}" ]; then
  ROOT="$DEVLOOP_ROOT"
elif ! ROOT="$(bash "$HERE/config.sh" root 2>/dev/null)" || [ -z "$ROOT" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): no .autofix.json found from $PWD and DEVLOOP_ROOT unset." >&2
  echo "$(basename "${BASH_SOURCE[0]}"): refusing to guess which workspace this is." >&2
  exit 6
fi
LOCK_PREFIX="${LOCK_PREFIX:-$(bash "$HERE/config.sh" lockPrefix 2>/dev/null || echo devloop)}"
PFX="${LOCK_PREFIX}"
SLOT=""; ID=""; REPO="site"; DRY=""; FORCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --slot) SLOT="${2:-}"; shift 2 ;;
    --id) ID="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-site}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

[ -n "$SLOT" ] && [ -n "$ID" ] || { echo "usage: kill-lane.sh --slot N --id app-xxxx [--repo site] [--dry-run] [--force]" >&2; exit 6; }

LANE=$((SLOT + 1))

# --repo takes a config KEY, and the key is not the directory. task.js pins its repo enum
# to site|extension|integration|docs, so a workspace whose checkouts are named otherwise
# maps key 'site' to path 'cli'. Joining the key onto ROOT sends this at $ROOT/site, which
# in such a workspace is a DIFFERENT REAL REPOSITORY - and this script deletes branches and
# removes worktrees, so operating in the wrong checkout is not a wrong answer, it is damage.
REPO_PATH="$(bash "$HERE/config.sh" "repos.${REPO}.path" 2>/dev/null)"
DIR="$ROOT/${REPO_PATH:-$REPO}"
if [ ! -d "$DIR/.git" ]; then
  echo "kill-lane.sh: $DIR is not a git checkout." >&2
  echo "kill-lane.sh: --repo takes a key from .autofix.json (have: $(bash "$HERE/config.sh" repos 2>/dev/null | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin)))" 2>/dev/null))." >&2
  exit 6
fi
VERDICT=""; LIVE=1
if [ -z "$FORCE" ]; then
  VERDICT="$(bash "$HERE/lane-running.sh" "$ID" 2>/dev/null)"; LIVE=$?
fi
if [ -z "$DRY" ] && [ -z "$FORCE" ]; then
  case "$LIVE" in
    1) ;;
    0)
      echo "REFUSING to clean up ${ID}: its lane is still running." >&2
      echo "$VERDICT" >&2
      echo "  Then run this again, or --force once you have confirmed it by hand." >&2
      exit 7 ;;
    *)
      echo "REFUSING to clean up ${ID}: cannot establish whether a lane is running." >&2
      echo "$VERDICT" >&2
      echo "  UNKNOWN is not dead. Confirm by hand, then re-run with --force." >&2
      exit 7 ;;
  esac
fi

busy_worktree() {
  local wt="$1" p g
  for p in rebase-merge rebase-apply MERGE_HEAD; do
    g="$(git -C "$wt" rev-parse --git-path "$p" 2>/dev/null)" || return 1
    case "$g" in /*) ;; *) g="$wt/$g" ;; esac
    [ -e "$g" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

if [ -z "$FORCE" ]; then
  seen_probe=""
  for raw in "/tmp/${PFX}-worktrees/${ID}" "/private/tmp/${PFX}-worktrees/${ID}" \
             "/tmp/${PFX}-worktrees/${ID}-rework" "/private/tmp/${PFX}-worktrees/${ID}-rework"; do
    [ -d "$raw" ] || continue
    probe="$(cd "$raw" 2>/dev/null && pwd -P)" || continue
    case " $seen_probe " in *" $probe "*) continue ;; esac
    seen_probe="$seen_probe $probe"
    state="$(busy_worktree "$probe")" || continue
    if [ -n "$DRY" ]; then
      echo "  would REFUSE: ${probe} is mid-${state}."
      continue
    fi
    echo "REFUSING to clean up ${ID}: ${probe} is mid-${state}." >&2
    echo "  The lander uses a lane's own worktree when it finds one holding the branch, so this" >&2
    echo "  may be a merge somebody else is in the middle of. Removing it now loses that work." >&2
    echo "  Wait for it, or --force once you have confirmed by hand." >&2
    exit 7
  done
fi

run() { if [ -n "$DRY" ]; then echo "  would: $*"; else eval "$@"; fi; }

echo "Cleaning up lane: slot ${SLOT} (lane ${LANE}), issue ${ID}, repo ${REPO}"
[ "$LIVE" = 0 ] && echo "  WARNING: lane-running.sh says a task for ${ID} is still in flight."
[ -n "$DRY" ] && echo "(dry run - nothing will be changed)"

# 1. The worktree, under either name a lane can check out to.
#
# RESCUE UNCOMMITTED WORK FIRST. A dead lane does not necessarily die empty. On 2026-08-30
# app-svio went silent with its pull request already pushed and green, and left NINE FILES
# STAGED AND NEVER COMMITTED - a half-finished refactor of the same feature. That was caught
# only because somebody looked by hand before running this script; `worktree remove --force`
# would have deleted it without printing anything, and nothing else on disk records it.
#
# The rescued diff is evidence, not a patch to reapply. Read it before believing it: that one
# turned out to be a regression and was rejected on its merits. But rejecting it was a
# judgement somebody got to make, which is the point.
RESCUE="${DEVLOOP_RESCUE:-$HOME/.claude/devloop-rescued}"

# BOTH SPELLINGS ARE PROBED, EACH REAL DIRECTORY IS HANDLED ONCE.
#
# On macOS /tmp is a symlink to private/tmp, so the two spellings name one inode. Probing
# both is deliberate and must stay: git records whichever it resolved, so a worktree can
# be registered under either name, and checking only one spelling reports a live lane as
# having no worktree.
#
# But treating them as two worktrees planned the whole sequence twice - remove, then
# attempt the same removal again, and write TWO rescue diffs to the same filename, the
# second overwriting the first. Harmless while both spellings hold identical content,
# which is always, until it is not - and a rescue file is what you reach for precisely
# when something has already gone wrong.
#
# So canonicalise, then deduplicate. The filename also carries the worktree basename,
# because the stamp has one-second resolution and an issue can have both a plain and a
# -rework worktree rescued inside the same second.
seen_wt=""
incomplete=0
incomplete_wts=""
for raw in "/tmp/${PFX}-worktrees/${ID}" "/private/tmp/${PFX}-worktrees/${ID}" \
           "/tmp/${PFX}-worktrees/${ID}-rework" "/private/tmp/${PFX}-worktrees/${ID}-rework"; do
  [ -d "$raw" ] || continue
  wt="$(cd "$raw" 2>/dev/null && pwd -P)" || continue
  case " $seen_wt " in *" $wt "*) continue ;; esac
  seen_wt="$seen_wt $wt"
  echo "worktree: $wt"

  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    stamp=$(date +%Y%m%d-%H%M%S)
    # The basename already carries the id, and distinguishes a -rework worktree from the
    # plain one - which the stamp alone cannot, at one-second resolution.
    out="${RESCUE}/$(basename "$wt")-${stamp}.diff"
    echo "  UNCOMMITTED WORK PRESENT - $(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ') path(s)"
    if [ -z "$DRY" ]; then
      mkdir -p "$RESCUE"
      # Untracked files need capturing separately and this is not a detail: `git diff` shows
      # neither them nor their contents, so a first version of this rescue counted "2 paths"
      # and then wrote a diff holding one. A lane that died having created a new spec, partial
      # or service would have been reported as rescued while exactly its new work was dropped.
      # Emitting each against /dev/null keeps the whole file applicable as one patch.
      { echo "# rescued from $wt on $stamp"
        echo "# issue $ID, branch $(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)"
        echo "# STAGED:"; git -C "$wt" diff --cached
        echo "# UNSTAGED:"; git -C "$wt" diff
        echo "# UNTRACKED (new files the lane created):"
        git -C "$wt" ls-files --others --exclude-standard -z |
          while IFS= read -r -d '' f; do
            git -C "$wt" diff --no-index --binary -- /dev/null "$f" || true
          done
      } > "$out"
      want=$( { git -C "$wt" diff --cached --name-only
                git -C "$wt" diff --name-only
                git -C "$wt" ls-files --others --exclude-standard; } | wc -l | tr -d ' ')
      got=$(grep -c '^diff --git ' "$out" 2>/dev/null || true)
      got="${got:-0}"
      if [ -s "$out" ] && [ "$got" -eq "$want" ]; then
        echo "  saved: $out (${got} of ${want} path(s))"
        echo "  READ IT before assuming the lane died with nothing worth keeping."
      else
        echo "  RESCUE INCOMPLETE - ${got} of ${want} path(s) reached $out"
        echo "  WORKTREE LEFT IN PLACE: $wt"
        incomplete=1
        incomplete_wts="$incomplete_wts $wt"
        continue
      fi
    else
      echo "  would save to: $out"
    fi
  fi

  run "git -C '$DIR' worktree remove --force '$wt' >/dev/null 2>&1 || rm -rf '$wt'"
done

if [ "$incomplete" = 1 ]; then
  echo
  echo "STOPPING: the rescue diff does not hold everything the worktree had, so nothing else was"
  echo "cleaned up - the branch, the lane lock and the slot claim are all still held."
  echo "Copy the work you want to keep out of the worktree, THEN REMOVE THE WORKTREE, then run this"
  echo "script again. A re-run with the worktree still there rescues the same paths, reports the same"
  echo "shortfall and stops here again - the lane stays blocked until the worktree is gone:"
  for wt in $incomplete_wts; do
    echo "  git -C '$DIR' worktree remove --force '$wt'"
  done
  exit 8
fi
run "git -C '$DIR' worktree prune"

# 2. The local branch, but ONLY when nothing was pushed. A branch whose commits reached origin is
# somebody's work and a pull request may already point at it; deleting it locally would not lose
# it, but deleting it as part of a cleanup invites deleting it remotely next.
branch="devloop/${ID}"
if git -C "$DIR" show-ref --verify --quiet "refs/heads/${branch}"; then
  if git -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
    echo "branch: ${branch} EXISTS ON ORIGIN - left alone. Check for an open pull request:"
    echo "         gh pr list --head ${branch} --state all"
  else
    echo "branch: ${branch} (local only, never pushed)"
    run "git -C '$DIR' branch -D '${branch}' >/dev/null"
  fi
fi

# 3. THE LANE LOCK. This is the one that gets forgotten. Bare directory in the correct form;
# a holder file inside means the merge lock's shape, which rmdir refuses, so remove it first.
lock="/tmp/${PFX}-lane-${LANE}.lock"
if [ -d "$lock" ]; then
  echo "lane lock: $lock (held since $(stat -f %Sm -t '%H:%M' "$lock" 2>/dev/null))"
  run "rm -f '$lock'/* 2>/dev/null; rmdir '$lock'"
  if [ -z "$DRY" ]; then
    [ -d "$lock" ] && echo "  STILL THERE - clear it by hand, it blocks every future run in this lane" || echo "  released"
  fi
else
  echo "lane lock: none held"
fi

# 4. The slot claim, only if it still names this issue - another dispatch may have taken the slot.
slot_file="/tmp/${PFX}-slots/${SLOT}"
if [ -f "$slot_file" ]; then
  held=$(cat "$slot_file" 2>/dev/null)
  if [ "$held" = "$ID" ]; then
    echo "slot claim: ${SLOT} -> ${ID}"
    run "rm -f '$slot_file'"
  else
    echo "slot claim: ${SLOT} now names '${held}', NOT ${ID} - left alone"
  fi
else
  echo "slot claim: none"
fi

echo
echo "Set the issue back so it can be picked up again, and say why - a re-dispatch with no note"
echo "looks like the ticket was never started:"
echo "  bd update ${ID} --status open --append-notes \"<what happened to the lane>\""
exit 0
