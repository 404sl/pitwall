#!/bin/bash
# Which lane-verified pull requests can no longer merge, and therefore will be dropped by the
# next train exactly as they were by the last one.
#
#   stranded.sh                 every configured repo
#   stranded.sh --repo site     one of them
#
# WHY. A train drops a branch that conflicts at file level and carries on. That is correct - the
# alternative is a train that stalls on one bad branch - but NOTHING re-queues the dropped one. It
# keeps its label, so it looks ready; it is offered to the next train, which drops it again,
# against a master that has moved further away. The conflict grows every round.
#
# It is worse for families of tickets that all append to one registry. Every tool page on this
# project adds an action to app/controllers/tools_controller.rb, a line to
# app/models/tools/catalog.rb and a copy block to all seven files under config/locales - so any
# two tool-page branches conflict BY CONSTRUCTION and a train can carry exactly one of them. On
# 2026-08-30 four ran at once: #762 landed, #763 was dropped with nine conflicts, and #739 was
# dropped twice before turning out to be a duplicate of #762 built from a second ticket.
#
# The supervisor was carrying that list in its head between trains, which does not survive a
# session ending. This computes it from git instead.
#
# Exit: 0 nothing stranded, 1 something is, 2 could not read a repo.

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
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) ONLY="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# path:slug, matching the rest of the skill.
# Slugs from each configured repo's own origin. Hardcoded they were one workspace's,
# so in any other workspace this looked up branches in repositories that have nothing to
# do with it - and reported every lane as stranded, because it found no branch anywhere.
REPOS="$(bash "$HERE/config.sh" repos 2>/dev/null | python3 -c '
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
    # EMIT THE PATH, NOT THE KEY. The consumer joins this onto ROOT to find the checkout.
    # A repo key and its directory differ whenever the key is constrained: task.js pins
    # its repo enum, so a workspace whose checkouts are named otherwise maps the key site
    # to the path cli. Emitting the key sent this at ROOT/site, which in that workspace is
    # a DIFFERENT REAL REPOSITORY - so there was no missing-directory error, merge-tree ran
    # against a repo with no commits, failed, and every open pull request was reported as
    # conflicting.
    print(cfg.get("path",name)+":"+url.rstrip("/").removesuffix(".git").split("github.com")[-1].lstrip(":/"))
' "$ROOT")"

found=0
inflight=""
while IFS=: read -r path slug; do
  [ -n "$path" ] || continue
  [ -z "$ONLY" ] || [ "$ONLY" = "$path" ] || continue
  dir="$ROOT/$path"
  [ -d "$dir" ] || continue

  git -C "$dir" fetch origin --quiet 2>/dev/null

  # The default branch is asked for rather than assumed: this project's repos are on master, but
  # the skill is meant to be shared, and guessing 'main' here would report every branch as clean.
  base=$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  base="${base:-origin/master}"

  # BOTH LABELLED AND UNLABELLED, and the unlabelled half is not an afterthought. rework.js
  # strips lane-verified while it works, deliberately, because a labelled branch that cannot
  # merge is a lie the lander keeps acting on. But that means a rework which dies leaves a pull
  # request that is stranded AND unlabelled - invisible to the train, which reads the label, and
  # invisible to a check that reads only labelled ones. That is the worst of the two states and
  # it is the one nothing was watching.
  prs=$(gh pr list --repo "$slug" --state open --json number,headRefName,labels \
        --jq '.[] | select(.headRefName | startswith("devloop/")) | "\(.number) \(.headRefName) \(if (.labels | map(.name) | index("lane-verified")) then "labelled" else "unlabelled" end)"' 2>/dev/null)
  [ -n "$prs" ] || continue

  while read -r num branch state; do
    [ -n "$num" ] || continue
    # merge-tree exits 1 on a file-level conflict and 0 on a merge that would succeed. This is the
    # same test the train makes, so agreeing with it is the point - a branch that passes here and
    # is still dropped means the train hit something else and that is worth knowing.
    out=$(git -C "$dir" merge-tree --write-tree "$base" "origin/$branch" 2>/dev/null)
    if [ $? -ne 0 ]; then
      files=$(printf '%s\n' "$out" | sed -n 's/^CONFLICT ([^)]*): Merge conflict in //p' | tr '\n' ' ')
      n=$(printf '%s\n' "$out" | grep -c '^CONFLICT')
      # AN UNLABELLED PULL REQUEST WITH A LIVE WORKTREE IS NOT STRANDED, IT IS BEING WORKED ON.
      # A build lane pushes before it hands off, so between its first push and its label its pull
      # request looks exactly like an abandoned one. #771 was reported that way on 2026-08-30
      # while its lane was still running. The worktree is what tells them apart: a lane removes
      # its own at handoff, so a worktree that still exists means somebody still holds this.
      id="${branch#devloop/}"
      live=""
      for w in "/tmp/${LOCK_PREFIX}-worktrees/$id" "/private/tmp/${LOCK_PREFIX}-worktrees/$id" \
               "/tmp/${LOCK_PREFIX}-worktrees/$id-rework" "/private/tmp/${LOCK_PREFIX}-worktrees/$id-rework"; do
        [ -d "$w" ] && live="$w" && break
      done

      if [ "$state" != "labelled" ] && [ -n "$live" ]; then
        inflight="${inflight}  ${path} #${num} ${branch} - a lane still holds ${live}
"
        continue
      fi

      if [ "$state" = "labelled" ]; then
        note="labelled ready - the next train WILL drop it"
      else
        note="NO LABEL AND NO WORKTREE - a lane died here and nothing is coming back for it"
      fi
      [ "$found" = "0" ] && {
        echo "STRANDED - an devloop pull request that cannot merge into its default branch:"
        echo
      }
      found=1
      printf '  %-8s #%-5s %s\n' "$path" "$num" "$branch"
      printf '           %s conflict(s): %s\n' "$n" "${files:-unknown}"
      printf '           %s\n' "$note"
    fi
  done <<EOF
$(printf '%s\n' "$prs")
EOF
done <<EOF
$(printf '%s\n' "$REPOS")
EOF

if [ -n "$inflight" ]; then
  echo
  echo "Conflicting but still being worked on, so NOT stranded - leave these alone:"
  printf '%s' "$inflight"
fi

if [ "$found" = "1" ]; then
  echo
  echo "Run rework on each BEFORE the next train, or the next train drops them again against a"
  echo "master that has moved further away:"
  echo "  args=\$(config.sh --args <id>); script=\$(run-script.sh rework.js)"
  echo "  Workflow({ scriptPath: <script>, args: { ...\$args, pr: <n>, repo: \"<repo>\" } })"
  exit 1
fi

# The in-flight list is printed once, above, whether or not anything is stranded. It used to be
# printed here as well, so a run with one in-flight branch and nothing stranded said the same
# thing twice - which reads like two findings.
echo "nothing stranded - every open devloop pull request that nobody holds can still merge"
exit 0
