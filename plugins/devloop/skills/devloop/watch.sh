#!/bin/bash
# What the supervisor should DO right now, in one line per actionable thing.
#
# WHY THIS EXISTS. The supervisor is not the only actor in a workspace. Another
# session merges a pull request, files a ticket, answers a decision or publishes a
# package, and the queue changes underneath a loop that is blocked waiting on its own
# lanes. Nothing tells it. On 2026-09-08 a pool of three ran one lane against twelve
# ready issues, with a labelled pull request waiting to be landed, because the events
# that made that work available all happened somewhere else.
#
# So this is deliberately NOT another dashboard. queue.sh prints state; this prints
# only the things that mean somebody should act, and prints nothing at all when there
# is nothing to do - which makes it usable as an event source rather than as a page to
# read.
#
#   watch.sh             print actionable state once and exit
#   watch.sh --loop [N]  poll every N seconds (default 60), print ONLY on change
#
# The loop form is meant to be attached to a monitor: every line it prints is an event
# worth waking somebody for, and silence means the world has not moved.
#
# It reads queue.sh rather than querying bd itself, on purpose. The rules for what
# counts as dispatchable - epics, umbrella parents, live children, park labels, blocked
# edges - live there and are worth more than the coupling costs. Duplicating them here
# would create a second answer to "is this workable" that drifts from the first.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# REFUSE RATHER THAN GUESS WHICH WORKSPACE THIS IS.
#
# config.sh finds .autofix.json by walking up from the cwd. Run from somewhere that has
# none - the skill's own directory, a home directory - it finds nothing, and a default
# would make this answer confidently about a DIFFERENT project: queue.sh's historical
# fallback points at one workspace, and a default lane count invents free lanes that
# may not exist. That is the failure queue.sh's own comments describe, where a script
# "looked configured while silently answering about somebody else's backlog".
#
# For a dashboard that is merely wasteful. For an event source that something acts on,
# it dispatches lanes into the wrong project. So: no fallback.
if ! ROOT="$(bash "$HERE/config.sh" root 2>/dev/null)" || [ -z "$ROOT" ]; then
  echo "watch.sh: no .autofix.json found from $PWD - run it from inside a workspace." >&2
  echo "watch.sh: refusing to guess, because guessing means reporting another project." >&2
  exit 2
fi
LANES="$(bash "$HERE/config.sh" lanes 2>/dev/null)"
[ -n "${LANES:-}" ] || LANES=3

# Repo slugs come from each checkout's own origin rather than from config, so a repo
# renamed on GitHub does not need an edit here.
repo_slugs() {
  bash "$HERE/config.sh" repos 2>/dev/null | python3 -c '
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
    slug=url.rstrip("/").removesuffix(".git").split("github.com")[-1].lstrip(":/")
    if slug: print(slug)
' "$ROOT" 2>/dev/null | sort -u
}

snapshot() {
  local q ready n free held out=""
  q="$(bash "$HERE/queue.sh" 2>/dev/null)" || return 0
  ready="$(printf '%s' "$q" | awk '/ready to start/{print $4; exit}')"
  [ -n "${ready:-}" ] || ready=0

  # OCCUPANCY COMES FROM THE REGISTRY, LIVENESS FROM THE WORKTREE. They are different
  # questions and they must not share an answer.
  #
  # This used to subtract queue.sh's "running now", which counts lanes with a RECENTLY
  # TOUCHED WORKTREE. A lane does not take a worktree at dispatch: a user-facing ticket
  # runs a design phase first, which takes minutes, and during it the lane holds its slot
  # and its claim and has no worktree at all. So this reported "1 of 3 lanes idle" while
  # slot.sh, bd in_progress and common sense all said three were held - and told a
  # supervisor to dispatch a fourth into a pool of three, which is two lanes sharing one
  # test database. That is the collision slot.sh exists to prevent.
  #
  # The skill already warns about this window for slot.sh --gc, which is destructive and
  # rare. It is worse here, because dispatching is the DEFAULT action and this line is
  # meant to be acted on at every tick.
  #
  # slot.sh --list is the registry, is scoped by lockPrefix from the config, and had the
  # right answer immediately. The worktree probe stays where it belongs - deciding whether
  # something is ALIVE - and is not consulted here.
  held="$(bash "$HERE/slot.sh" --list 2>/dev/null | grep -c 'slot [0-9]* ->')"
  [ -n "${held:-}" ] || held=0
  free=$(( LANES - held ))
  [ "$free" -lt 0 ] && free=0

  local dispatch=""
  if [ "$free" -gt 0 ] && [ "$ready" -gt 0 ]; then
    n=$(( free < ready ? free : ready ))
    dispatch="DISPATCH ${n}: ${free} of ${LANES} lanes idle, ${ready} ready"
  fi

  # A labelled pull request that nothing is landing is the pipeline's output sitting
  # where nobody sees it. Report every repo, not just the first.
  #
  # AN EMPTY RESULT AND A FAILED QUERY ARE NOT THE SAME ANSWER, and collapsing them is
  # the whole reason this script exists. An earlier version discarded gh's exit status
  # and tested only whether the output was empty, so a rate-limited or unauthenticated
  # gh reported "nothing to land" - indistinguishable from a clean queue, and silently
  # wrong in the direction that stalls the pipeline. Caught within an hour of writing
  # it, by a run whose LAND line vanished while a labelled pull request was open.
  local slug labelled rc
  while read -r slug; do
    [ -n "$slug" ] || continue
    labelled="$(gh pr list --repo "$slug" --state open --label lane-verified \
                 --json number --jq '[.[].number]|join(",")' 2>/dev/null)"
    rc=$?
    if [ $rc -ne 0 ]; then
      out="${out}UNKNOWN ${slug}: gh failed (exit ${rc}) - cannot tell if anything is waiting to land"$'\n'
    elif [ -n "${labelled:-}" ]; then
      out="${out}LAND ${slug}: #${labelled} labelled and waiting"$'\n'

      # A LABELLED PULL REQUEST THAT DELETES AN EXPORTED SYMBOL LAND-MINES EVERY BRANCH
      # CUT BEFORE IT LANDS. The new branch imports the symbol from where it currently
      # lives, passes review, passes CI, and is wrong the moment that PR merges - and
      # nothing textual conflicts, so git cannot see it either. Three branches hit this
      # on 2026-08-08 over one function moving between files.
      #
      # Without this check the DISPATCH line above is confidently wrong for exactly the
      # window in which it matters most, and a supervisor following it manufactures the
      # defect. Detected rather than declared: no label to remember, no ticket to file.
      local pr removed
      for pr in ${labelled//,/ }; do
        removed="$(gh pr diff "$pr" --repo "$slug" 2>/dev/null \
          | grep -E '^-[^-]' \
          | grep -oE 'export (function|const|class|type|interface|enum) [A-Za-z_][A-Za-z0-9_]*' \
          | awk '{print $NF}' | sort -u | tr '\n' ' ')"
        if [ -n "${removed// /}" ]; then
          out="${out}HOLD ${slug}: #${pr} removes exported ${removed}- do not cut new branches here until it lands"$'\n'
        fi
      done
    fi
  done < <(repo_slugs)

  # A claim with no worktree and no live run holds an issue out of the queue forever.
  local stranded
  stranded="$(printf '%s' "$q" | awk '/STALE .*workflow probably died/{print $1}' | tr '\n' ' ')"
  [ -n "${stranded// /}" ] && out="${out}STRANDED: ${stranded}"$'\n'

  # DISPATCH is emitted LAST, and qualified, because whether it is safe depends on
  # what the HOLD check found.
  if [ -n "$dispatch" ]; then
    if printf '%s' "$out" | grep -q '^HOLD '; then
      out="${out}${dispatch} - BUT SEE HOLD ABOVE: not safe for the held repo"$'\n'
    else
      out="${out}${dispatch}"$'\n'
    fi
  fi

  printf '%s' "$out"
}

if [ "${1:-}" = "--loop" ]; then
  interval="${2:-60}"
  last=""
  while true; do
    now="$(snapshot)"
    # Only transitions are events. Reprinting an unchanged state every minute would
    # train whoever is reading to ignore it, which is the failure mode of every alert
    # that has ever been muted.
    if [ "$now" != "$last" ] && [ -n "$now" ]; then
      # printf '%s' loses the final newline, because $(snapshot) strips trailing newlines
      # in command substitution. That matters more here than it looks: this output is an
      # EVENT STREAM, and a line without its terminator runs into the first line of the
      # next poll - "...labelled and waitingDISPATCH 3: ..." - so two events arrive as one
      # unparseable line. Print the whole block and terminate it.
      printf '%s\n' "$now"
    fi
    last="$now"
    sleep "$interval"
  done
else
  out="$(snapshot)"
  if [ -z "$out" ]; then
    echo "nothing to do: lanes busy or nothing dispatchable, nothing labelled, no stale claims"
  else
    # Terminated, for the same reason as the loop path: command substitution strips the
    # trailing newline and a caller piping this gets its last line glued to whatever
    # follows.
    printf '%s\n' "$out"
  fi
fi
