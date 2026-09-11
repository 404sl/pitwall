#!/bin/bash
# Prepare ONE pull request for merging, and stop before the merge.
#
# WHY THIS EXISTS. Landing a PR was ninety-odd tool calls inside one agent - check master, take
# a worktree, rebase, push, ask GitHub whether CI has finished, ask again, ask again, merge,
# confirm master, clean up. Measured on 2026-08-28, a land agent took about ten minutes of which
# 5.2 was CI, and the rest was round trips at roughly seven seconds each. Exactly one step in
# that sequence needs judgement: deciding whether a rebase conflict is textual or semantic. The
# other eight are git and gh with no opinion in them, which is what this script is.
#
# IT DOES NOT MERGE, DELIBERATELY. The merge is the one action the safety classifier gates, and
# it wants the evidence in the transcript of whoever orders it (see app-a8cc). A script that
# merged would either be refused or would need a standing allow rule nobody has agreed to. So
# this hands back 'ready', and the caller does the two-line merge itself.
#
# Usage:
#   land-one.sh --repo-path <abs> --slug <owner/name> --pr <n> --branch <name> [--prefix devloop]
#
# Exit codes, which are the interface - stdout is for a human, the code is for the caller:
#   0  ready      rebased if needed, pushed, CI green on the pushed head. Merge it.
#   3  conflict   rebase hit a conflict. Aborted, worktree removed. A person decides.
#   4  red        CI FAILED on the rebased head. A real failure; the PR is not landable as is.
#   7  not_ready  the rollup is empty or describes an older head - CI has not finished
#                 registering. NOT a failure and NOT the same as 4: the caller must retry this
#                 one in a later round rather than retiring it, which is what the separate
#                 verify agent used to be for.
#   5  master_red master was not green before starting. Nothing was touched.
#   6  usage      bad arguments, or the repository/branch does not exist.

set -u

# Default from the WORKSPACE, not from one workspace's prefix. This decides which
# /tmp/<prefix>-worktrees a merge writes into, so a wrong one silently operates in
# another project's scratch space rather than failing.
PREFIX="$(bash "$(dirname "${BASH_SOURCE[0]}")/config.sh" lockPrefix 2>/dev/null || echo devloop)"
LABEL=lane-verified
REPO_PATH=""; SLUG=""; PR=""; BRANCH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) REPO_PATH="${2:-}"; shift 2 ;;
    --slug)      SLUG="${2:-}";      shift 2 ;;
    --pr)        PR="${2:-}";        shift 2 ;;
    --branch)    BRANCH="${2:-}";    shift 2 ;;
    --prefix)    PREFIX="${2:-}";    shift 2 ;;
    --label)     LABEL="${2:-}";     shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

for req in REPO_PATH SLUG PR BRANCH; do
  eval "v=\$$req"
  [ -n "$v" ] || { echo "missing --$(echo "$req" | tr 'A-Z_' 'a-z-')" >&2; exit 6; }
done
[ -d "$REPO_PATH/.git" ] || [ -f "$REPO_PATH/.git" ] || { echo "not a git repository: $REPO_PATH" >&2; exit 6; }
case "$PR" in ''|*[!0-9]*) echo "--pr must be a number, got: $PR" >&2; exit 6 ;; esac

WT="/tmp/${PREFIX}-worktrees/land-${PR}"
say() { printf '%s\n' "$*"; }

# Everything below runs against the worktree, never the main checkout. A person works in that
# checkout on their own branch with their own uncommitted edits, and a stray checkout there has
# already destroyed somebody's credentials work once.
cleanup() {
  cd "$REPO_PATH" 2>/dev/null || return 0
  git worktree remove "$WT" --force >/dev/null 2>/dev/null
  git worktree prune >/dev/null 2>/dev/null
}

cd "$REPO_PATH" || exit 6
git fetch origin --quiet 2>/dev/null

ident_name=$(git log -1 --format=%an origin/master 2>/dev/null)
ident_email=$(git log -1 --format=%ae origin/master 2>/dev/null)
git_with_identity() {
  if [ -n "$ident_name" ] && [ -n "$ident_email" ]; then
    git -c "user.name=$ident_name" -c "user.email=$ident_email" "$@"
  else
    git "$@"
  fi
}

# 1. MASTER MUST BE GREEN FIRST. Landing on top of a break makes it harder to untangle, not
#    easier, and the lander cannot merge the fix for a red master while master is red.
master_state=$(gh run list --branch master --limit 1 --json status,conclusion 2>/dev/null \
  | python3 -c "
import json,sys
r=json.load(sys.stdin)
print('%s/%s' % (r[0].get('status'), r[0].get('conclusion')) if r else 'none/none')
" 2>/dev/null)
case "$master_state" in
  completed/success) ;;
  *) say "master_red: master is $master_state - nothing touched"; exit 5 ;;
esac

# 2. Is the branch already on top of master? If so there is nothing to rebase and nothing to
#    push, and re-pushing an unchanged head would start a second CI run for no reason.
behind=$(git rev-list --count "origin/${BRANCH}..origin/master" 2>/dev/null || echo unknown)
case "$behind" in ''|*[!0-9]*) say "usage: no such branch origin/${BRANCH}"; exit 6 ;; esac

if [ "$behind" = "0" ]; then
  say "current: ${BRANCH} is already on top of master, no rebase needed"
else
  rm -rf "$WT" 2>/dev/null
  mkdir -p "/tmp/${PREFIX}-worktrees"
  git worktree add --force "$WT" "origin/${BRANCH}" >/dev/null 2>/dev/null || {
    say "usage: could not create a worktree for ${BRANCH}"; exit 6; }
  cd "$WT" || { cleanup; exit 6; }
  git checkout -B "$BRANCH" "origin/${BRANCH}" >/dev/null 2>/dev/null

  if ! git_with_identity rebase origin/master >/dev/null 2>/dev/null; then
    # A conflict is a decision, not a task. Report WHAT disagrees and hand it back; guessing
    # here is how a merge that is green on both sides breaks the product.
    files=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    git rebase --abort >/dev/null 2>/dev/null
    cd "$REPO_PATH" || true
    cleanup
    say "conflict: ${BRANCH} conflicts with master in: ${files:-unknown}"
    exit 3
  fi

  # Never force-push a default branch; this is not one, and the guard proves it rather than
  # trusting that the cd above went where it was meant to.
  if ! git-guard --dir="$WT" --branch="$BRANCH" -- git push --force-with-lease >/dev/null 2>/dev/null; then
    cd "$REPO_PATH" || true; cleanup
    say "usage: push --force-with-lease was refused for ${BRANCH}"; exit 6
  fi
  cd "$REPO_PATH" || true
  cleanup
  say "rebased: ${BRANCH} was ${behind} behind, rebased and pushed"
fi

# 3. WAIT FOR CI ON THE HEAD THAT IS ACTUALLY THERE NOW, and wait by blocking rather than by
#    polling. gh streams the result, so this costs one call and no interval latency; the old
#    loop asked every few seconds and noticed late. --fail-fast returns as soon as one fails.
if ! gh pr checks "$PR" --repo "$SLUG" --watch --fail-fast >/dev/null 2>/dev/null; then
  head_now=$(git rev-parse "origin/${BRANCH}" 2>/dev/null)
  say "red: checks failed on ${BRANCH} at ${head_now}"
  exit 4
fi

# 4. Read the rollup back rather than trusting the exit code, and refuse an EMPTY one. Every
#    reader of a rollup in this pipeline has to be told this: "every entry is green" is
#    vacuously true of an empty array and reads as a pass forever.
git fetch origin --quiet 2>/dev/null
head_sha=$(git rev-parse "origin/${BRANCH}" 2>/dev/null)
verdict=$(gh pr view "$PR" --repo "$SLUG" --json labels,statusCheckRollup,headRefOid 2>/dev/null \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
rollup=d.get('statusCheckRollup') or []
labels=[l['name'] for l in d.get('labels') or []]
if not rollup:
    print('EMPTY|%s|%s' % (d.get('headRefOid',''), ','.join(labels))); raise SystemExit
bad=[c.get('name') for c in rollup if c.get('conclusion') not in ('SUCCESS','NEUTRAL','SKIPPED')]
print('%s|%s|%s' % ('BAD:'+','.join(bad) if bad else 'GREEN', d.get('headRefOid',''), ','.join(labels)))
" 2>/dev/null)

state=${verdict%%|*}; rest=${verdict#*|}; rollup_head=${rest%%|*}; labels=${rest#*|}

case "$state" in
  GREEN) ;;
  EMPTY) say "not_ready: rollup is empty on ${PR} - no check has registered, which is not a pass"; exit 7 ;;
  *)     say "red: ${state} on ${PR}"; exit 4 ;;
esac

# IS THE LABEL STILL THERE? A lane can pull it back while a run is in flight, and that is the
# lane saying do not merge this. Observed once, which is why the pipeline used to spawn a whole
# separate agent to ask. It asks here now.
case ",$labels," in
  *,"$LABEL",*) ;;
  *) say "not_ready: ${PR} no longer carries ${LABEL} - labels are: ${labels:-none}"; exit 7 ;;
esac

# The rollup has to describe the commit that is actually on the branch, not an earlier one.
if [ -n "$rollup_head" ] && [ "$rollup_head" != "$head_sha" ]; then
  say "not_ready: rollup describes ${rollup_head} but the branch head is ${head_sha}"
  exit 7
fi

say "ready: ${SLUG}#${PR} at ${head_sha}"
say "labels: ${labels:-none}"
say ""
say "Merge it yourself - this script deliberately does not. Show the evidence first:"
say "  gh pr view ${PR} --repo ${SLUG} --json labels,statusCheckRollup"
say "  gh pr merge ${PR} --repo ${SLUG} --squash --delete-branch"
exit 0
