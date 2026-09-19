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
#               [--base master] [--register-wait 180] [--register-interval 15]
#
# Exit codes, which are the interface - stdout is for a human, the code is for the caller:
#   0  ready      rebased if needed, pushed, CI green on the pushed head. Merge it.
#   3  conflict   rebase hit a conflict. Aborted, worktree removed. A person decides.
#   4  red        CI FAILED on the rebased head. A real failure; the PR is not landable as is.
#   7  not_ready  the rollup is empty, has a check that has not concluded, or describes an older
#                 head - CI has not finished registering. NOT a failure and NOT the same as 4:
#                 the caller must retry this one in a later round rather than retiring it, which
#                 is what the separate verify agent used to be for.
#   8  merge_shaped the branch carries a merge commit of its own and master has moved under it, so
#                 a rebase would replay only its own commits and drop whatever exists solely in
#                 that merge's resolution. Nothing was touched. Like 7 this is not a failure of
#                 the work: it needs rework, not retiring.
#   9  unreadable the rollup, or master's latest run before it, could not be read AT ALL - a
#                 throttled or failing gh, or output that did not parse. Nothing is known about
#                 the checks or about master, which is not the same as knowing they failed.
#                 Retry it in a later round like 7; never report it as red or as a red master.
#   5  master_red master's latest run was READ and was not green before starting. Nothing was
#                 touched.
#   6  usage      bad arguments, or the repository/branch does not exist, or the base branch
#                 this was handed is not the default branch GitHub reports for the repository,
#                 or not the branch the pull request is open against.

set -u

# Default from the WORKSPACE, not from one workspace's prefix. This decides which
# /tmp/<prefix>-worktrees a merge writes into, so a wrong one silently operates in
# another project's scratch space rather than failing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="$(bash "$HERE/config.sh" lockPrefix 2>/dev/null || echo devloop)"
GUARD="$HERE/git-guard.sh"
LABEL=lane-verified
REPO_PATH=""; SLUG=""; PR=""; BRANCH=""; BASE=master
REGISTER_WAIT=180; REGISTER_INTERVAL=15

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path)
      [ $# -ge 2 ] || { echo "--repo-path needs a value" >&2; exit 6; }
      REPO_PATH="${2:-}"; shift 2 ;;
    --slug)
      [ $# -ge 2 ] || { echo "--slug needs a value" >&2; exit 6; }
      SLUG="${2:-}"; shift 2 ;;
    --pr)
      [ $# -ge 2 ] || { echo "--pr needs a value" >&2; exit 6; }
      PR="${2:-}"; shift 2 ;;
    --branch)
      [ $# -ge 2 ] || { echo "--branch needs a value" >&2; exit 6; }
      BRANCH="${2:-}"; shift 2 ;;
    --prefix)
      [ $# -ge 2 ] || { echo "--prefix needs a value" >&2; exit 6; }
      PREFIX="${2:-}"; shift 2 ;;
    --base)
      [ $# -ge 2 ] || { echo "--base needs a value" >&2; exit 6; }
      BASE="${2:-}"; shift 2 ;;
    --label)
      [ $# -ge 2 ] || { echo "--label needs a value" >&2; exit 6; }
      LABEL="${2:-}"; shift 2 ;;
    --register-wait)
      [ $# -ge 2 ] || { echo "--register-wait needs a value" >&2; exit 6; }
      REGISTER_WAIT="${2:-}"; shift 2 ;;
    --register-interval)
      [ $# -ge 2 ] || { echo "--register-interval needs a value" >&2; exit 6; }
      REGISTER_INTERVAL="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

for req in REPO_PATH SLUG PR BRANCH; do
  eval "v=\$$req"
  [ -n "$v" ] || { echo "missing --$(echo "$req" | tr 'A-Z_' 'a-z-')" >&2; exit 6; }
done
[ -d "$REPO_PATH/.git" ] || [ -f "$REPO_PATH/.git" ] || { echo "not a git repository: $REPO_PATH" >&2; exit 6; }
case "$PR" in ''|*[!0-9]*) echo "--pr must be a number, got: $PR" >&2; exit 6 ;; esac
case "$REGISTER_WAIT" in ''|*[!0-9]*) echo "--register-wait must be a number of seconds, got: $REGISTER_WAIT" >&2; exit 6 ;; esac
case "$REGISTER_INTERVAL" in ''|*[!0-9]*) echo "--register-interval must be a number of seconds, got: $REGISTER_INTERVAL" >&2; exit 6 ;; esac
[ -n "$BASE" ] || { echo "usage: --base must name a branch" >&2; exit 6; }
case "$BRANCH" in master|main|"$BASE") echo "usage: ${BRANCH} is a default branch and is never landed onto itself" >&2; exit 6 ;; esac

WT="/tmp/${PREFIX}-worktrees/land-${PR}"
say() { printf '%s\n' "$*"; }

guard_verdict() {
  local rc=$1 errf=$2 what=$3 ref=$4 reason=""
  reason=$(grep -m1 '^git-guard\.sh: ' "$errf" 2>/dev/null)
  [ -n "$reason" ] || reason=$(grep -v '^[[:space:]]*$' "$errf" 2>/dev/null | tail -1)
  cat "$errf" >&2
  case "$rc" in
    2)       printf 'usage: the guard refused %s for %s - %s\n' \
               "$what" "$ref" "${reason:-it gave no reason}" ;;
    126|127) printf 'usage: the guard %s could not be run, exit %s - %s. %s was never attempted for %s\n' \
               "$GUARD" "$rc" "${reason:-it printed nothing}" "$what" "$ref" ;;
    *)       printf 'usage: %s failed for %s, exit %s - %s\n' \
               "$what" "$ref" "$rc" "${reason:-nothing was printed}" ;;
  esac
}

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

github_default=$(timeout "${DEVLOOP_GH_TIMEOUT:-30}" gh repo view "$SLUG" --json defaultBranchRef 2>/dev/null \
  | python3 -c "import json,sys; print((json.load(sys.stdin).get('defaultBranchRef') or {}).get('name') or '')" 2>/dev/null)
if [ -z "$github_default" ]; then
  echo "usage: could not read the default branch of ${SLUG} from 'gh repo view ${SLUG} --json defaultBranchRef' within ${DEVLOOP_GH_TIMEOUT:-30}s, so nothing is known about whether ${BASE} is its default - nothing touched"
  exit 6
fi
if [ "$github_default" != "$BASE" ]; then
  echo "usage: this run was handed base branch '${BASE}' for ${SLUG} but GitHub says its default branch is '${github_default}' - refusing before any worktree is cut or rebase runs, because git and GitHub would disagree about what ${BRANCH} lands on. Set repos.<key>.defaultBranch to '${github_default}' in the workspace config"
  exit 6
fi

PR_BASE_ATTEMPT="gh pr view ${PR} --repo ${SLUG} --json baseRefName"
pr_base=$(timeout "${DEVLOOP_GH_TIMEOUT:-30}" gh pr view "$PR" --repo "$SLUG" --json baseRefName 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('baseRefName') or '')" 2>/dev/null)
if [ -z "$pr_base" ]; then
  echo "usage: could not read the base branch of ${SLUG}#${PR} from '${PR_BASE_ATTEMPT}' within ${DEVLOOP_GH_TIMEOUT:-30}s, so nothing is known about whether it is open against ${BASE} - nothing touched"
  exit 6
fi
if [ "$pr_base" != "$BASE" ]; then
  echo "usage: ${SLUG}#${PR} is open against '${pr_base}' but this run was handed base branch '${BASE}' - refusing before any worktree is cut or rebase runs, because the rebase would go onto ${BASE} and the merge would land on ${pr_base}. GitHub reports ${BASE} as the default branch of ${SLUG}, so retarget the pull request with 'gh pr edit ${PR} --repo ${SLUG} --base ${BASE}'"
  exit 6
fi

ident_name=$(git log -1 --format=%an "origin/${BASE}" 2>/dev/null)
ident_email=$(git log -1 --format=%ae "origin/${BASE}" 2>/dev/null)
git_with_identity() {
  if [ -n "$ident_name" ] && [ -n "$ident_email" ]; then
    git -c "user.name=$ident_name" -c "user.email=$ident_email" "$@"
  else
    git "$@"
  fi
}

# 1. MASTER MUST BE GREEN FIRST. Landing on top of a break makes it harder to untangle, not
#    easier, and the lander cannot merge the fix for a red master while master is red.
read_dir=$(mktemp -d "/tmp/${PREFIX}-rollup-XXXXXX" 2>/dev/null) || read_dir=""
trap 'rm -rf "$read_dir" 2>/dev/null' EXIT
if [ -n "$read_dir" ]; then
  gh_err="$read_dir/gh.err"; py_err="$read_dir/python.err"
else
  gh_err=/dev/null; py_err=/dev/null
fi

MASTER_ATTEMPT="gh run list --branch ${BASE} --limit 1 --json status,conclusion"
runs_json=$(gh run list --branch "$BASE" --limit 1 --json status,conclusion 2>"$gh_err")
gh_code=$?
if [ "$gh_code" -ne 0 ] || [ -z "$runs_json" ]; then
  said=$(head -n 1 "$gh_err" 2>/dev/null)
  say "unreadable: could not read ${BASE}'s latest run for ${SLUG} - nothing is known about ${BASE}"
  say "attempted: ${MASTER_ATTEMPT}"
  say "gh exited ${gh_code} and said: ${said:-nothing on stderr}"
  say "This is NOT a red master and nothing was touched. Retry it in a later round."
  exit 9
fi

master_state=$(printf '%s' "$runs_json" | python3 -c "
import json,sys
r=json.load(sys.stdin)
print('%s/%s' % (r[0].get('status'), r[0].get('conclusion')) if r else 'none/none')
" 2>"$py_err")
py_code=$?
if [ "$py_code" -ne 0 ] || [ -z "$master_state" ]; then
  said=$(tail -n 1 "$py_err" 2>/dev/null)
  began=$(printf '%s' "$runs_json" | head -c 120 | tr '\n\t' '  ')
  say "unreadable: ${BASE}'s latest run for ${SLUG} did not parse - nothing is known about ${BASE}"
  say "attempted: ${MASTER_ATTEMPT}"
  say "the reader exited ${py_code} and said: ${said:-nothing on stderr}"
  say "gh returned ${#runs_json} bytes beginning: ${began}"
  say "This is NOT a red master and nothing was touched. Retry it in a later round."
  exit 9
fi

case "$master_state" in
  completed/success) ;;
  *) say "master_red: ${BASE} is $master_state - nothing touched"; exit 5 ;;
esac

# 2. Is there anything to do to the branch before it merges? Two things can be: a rebase when
#    master has moved under it, and the plugin version when the branch changes a file the
#    marketplace serves. A branch needing neither is not pushed, and re-pushing an unchanged
#    head would start a second CI run for no reason.
behind=$(git rev-list --count "origin/${BRANCH}..origin/${BASE}" 2>/dev/null || echo unknown)
case "$behind" in ''|*[!0-9]*) say "usage: no such branch origin/${BRANCH}"; exit 6 ;; esac

if [ "$behind" != "0" ]; then
  merges=$(git rev-list --merges --count "origin/${BASE}..origin/${BRANCH}" 2>/dev/null || echo unknown)
  case "$merges" in ''|*[!0-9]*) say "usage: could not count merge commits on origin/${BRANCH}"; exit 6 ;; esac
  if [ "$merges" != "0" ]; then
    say "merge_shaped: ${BRANCH} carries ${merges} merge commit(s) of its own and is ${behind} behind ${BASE} - a rebase would keep none of them and drop whatever exists only in the resolution, so nothing was touched. Rework it onto ${BASE}."
    exit 8
  fi
fi

plugin_paths=$(git diff --name-only "origin/${BASE}...origin/${BRANCH}" 2>/dev/null \
  | grep -E '^(plugins/|\.claude-plugin/)' | head -3 | tr '\n' ' ')

pushed_sha=""
if [ "$behind" = "0" ] && [ -z "$plugin_paths" ]; then
  say "current: ${BRANCH} is already on top of ${BASE} and ships no plugin file, no rebase needed"
else
  head_before=$(git rev-parse "origin/${BRANCH}" 2>/dev/null)
  holder=$(git worktree list --porcelain 2>/dev/null | awk -v ref="branch refs/heads/${BRANCH}" '
    /^worktree /{wt=substr($0, 10)} $0==ref{print wt; exit}')
  [ -z "$holder" ] || say "held: ${BRANCH} is checked out in ${holder}, so this run works detached from origin/${BRANCH} and leaves that worktree alone"
  rm -rf "$WT" 2>/dev/null
  mkdir -p "/tmp/${PREFIX}-worktrees"
  git worktree add --force --detach "$WT" "origin/${BRANCH}" >/dev/null 2>"$gh_err" || {
    said=$(tail -n 1 "$gh_err" 2>/dev/null)
    say "usage: could not create a worktree for ${BRANCH} - git said: ${said:-nothing on stderr}"; exit 6; }
  cd "$WT" || { cleanup; exit 6; }

  dropped=0
  while [ "$dropped" -lt 20 ]; do
    case "$(git log -1 --format=%s HEAD 2>/dev/null)" in
      "Set the plugin version "*|"Set devloop plugin version "*) ;;
      *) break ;;
    esac
    git rev-parse --verify --quiet HEAD~1 >/dev/null 2>/dev/null || break
    [ "$(git rev-list --count "origin/${BASE}..HEAD~1" 2>/dev/null || echo 0)" -ge 1 ] || break
    changed=$(git diff --name-only HEAD~1 HEAD 2>/dev/null)
    [ -n "$changed" ] || break
    printf '%s\n' "$changed" \
      | grep -qvE '^(\.claude-plugin/marketplace\.json|plugins/devloop/\.claude-plugin/plugin\.json|plugins/devloop/skills/devloop/CHANGELOG\.md)$' \
      && break
    git reset --hard HEAD~1 >/dev/null 2>/dev/null || break
    dropped=$((dropped + 1))
  done
  [ "$dropped" = "0" ] || say "dropped: ${dropped} version commit(s) an earlier round wrote onto ${BRANCH} - the number is counted again from ${BASE} as it is now"

  if [ "$behind" != "0" ] && ! git_with_identity rebase "origin/${BASE}" >/dev/null 2>/dev/null; then
    # A conflict is a decision, not a task. Report WHAT disagrees and hand it back; guessing
    # here is how a merge that is green on both sides breaks the product.
    files=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    git rebase --abort >/dev/null 2>/dev/null
    cd "$REPO_PATH" || true
    cleanup
    say "conflict: ${BRANCH} conflicts with ${BASE} in: ${files:-unknown}"
    exit 3
  fi

  version_note=""
  if [ -n "$plugin_paths" ]; then
    version_out=$(bash "$HERE/assign-plugin-version.sh" --worktree "$WT" --base "origin/${BASE}" --slug "$SLUG" --pr "$PR" 2>/dev/null)
    version_code=$?
    case "$version_code" in
      0) version_note=$(printf '%s\n' "$version_out" | head -1) ;;
      2) version_note=$(printf '%s\n' "$version_out" | head -1) ;;
      *) cd "$REPO_PATH" || true; cleanup
         say "usage: the devloop plugin version could not be assigned for ${BRANCH} - ${version_out:-assign-plugin-version.sh printed nothing}"
         exit 6 ;;
    esac
  fi

  head_after=$(git rev-parse HEAD 2>/dev/null)
  tree_after=$(git rev-parse "HEAD^{tree}" 2>/dev/null)
  tree_before=$(git rev-parse "origin/${BRANCH}^{tree}" 2>/dev/null)
  if [ "$head_after" = "$head_before" ] \
     || { [ "$behind" = "0" ] && [ -n "$tree_after" ] && [ "$tree_after" = "$tree_before" ]; }; then
    git reset --hard "origin/${BRANCH}" >/dev/null 2>/dev/null
    cd "$REPO_PATH" || true
    cleanup
    say "current: ${BRANCH} needs no rebase and already carries the version it would be assigned, nothing pushed"
    [ -n "$version_note" ] && say "version: ${version_note}"
  else
    # Never force-push a default branch; this is not one, and the guard proves the cd above went
    # where it was meant to.
    guard_err=$(mktemp "${TMPDIR:-/tmp}/guard-err.XXXXXX")
    bash "$GUARD" --dir="$WT" --default="$BASE" -- git push --force-with-lease="refs/heads/${BRANCH}:${head_before}" origin "HEAD:refs/heads/${BRANCH}" >/dev/null 2>"$guard_err"
    guard_rc=$?
    if [ "$guard_rc" != 0 ]; then
      verdict=$(guard_verdict "$guard_rc" "$guard_err" "push --force-with-lease" "$BRANCH")
      rm -f "$guard_err"
      cd "$REPO_PATH" || true; cleanup
      say "$verdict"; exit 6
    fi
    rm -f "$guard_err"
    cd "$REPO_PATH" || true
    cleanup
    pushed_sha="$head_after"
    say "pushed: ${BRANCH} was ${behind} behind ${BASE}, rebased where it had to be, and pushed"
    [ -n "$version_note" ] && say "version: ${version_note}"
  fi
fi

registered_checks() {
  gh api "repos/${SLUG}/commits/${1}/check-runs" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('total_count') or len(d.get('check_runs') or []))
" 2>/dev/null
}

if [ -n "$pushed_sha" ]; then
  register_started=$(date +%s)
  while :; do
    registered=$(registered_checks "$pushed_sha")
    case "$registered" in ''|*[!0-9]*) registered=0 ;; esac
    [ "$registered" -gt 0 ] && break
    register_elapsed=$(( $(date +%s) - register_started ))
    if [ "$register_elapsed" -ge "$REGISTER_WAIT" ]; then
      say "not_ready: no check registered on ${pushed_sha} within ${REGISTER_WAIT}s of the push - nothing has run yet, which is not a pass"
      exit 7
    fi
    sleep "$REGISTER_INTERVAL"
  done
  say "registered: ${registered} check(s) on ${pushed_sha} after $(( $(date +%s) - register_started ))s"
fi

# 3. WAIT FOR CI ON THE HEAD THAT IS ACTUALLY THERE NOW, and wait by blocking rather than by
#    polling. gh streams the result, so this costs one call and no interval latency; the old
#    loop asked every few seconds and noticed late. --fail-fast returns as soon as one fails.
gh pr checks "$PR" --repo "$SLUG" --watch --fail-fast >/dev/null 2>/dev/null
checks_code=$?
if [ "$checks_code" -ne 0 ]; then
  say "checks: gh pr checks exited ${checks_code} for ${SLUG}#${PR} - reading the rollup to find out why"
fi

# 4. Read the rollup back rather than trusting the exit code, and refuse an EMPTY one. Every
#    reader of a rollup in this pipeline has to be told this: "every entry is green" is
#    vacuously true of an empty array and reads as a pass forever.
git fetch origin --quiet 2>/dev/null
head_sha=$(git rev-parse "origin/${BRANCH}" 2>/dev/null)
READ_ATTEMPT="gh pr view ${PR} --repo ${SLUG} --json labels,statusCheckRollup,headRefOid"
rollup_json=$(gh pr view "$PR" --repo "$SLUG" --json labels,statusCheckRollup,headRefOid 2>"$gh_err")
gh_code=$?
if [ "$gh_code" -ne 0 ] || [ -z "$rollup_json" ]; then
  said=$(head -n 1 "$gh_err" 2>/dev/null)
  say "unreadable: could not read the status rollup for ${SLUG}#${PR} - nothing is known about its checks"
  say "attempted: ${READ_ATTEMPT}"
  say "gh exited ${gh_code} and said: ${said:-nothing on stderr}"
  say "This is NOT a red pull request and it was not merged. Retry it in a later round."
  exit 9
fi

verdict=$(printf '%s' "$rollup_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rollup=d.get('statusCheckRollup') or []
labels=[l['name'] for l in d.get('labels') or []]
if not rollup:
    print('EMPTY|%s|%s' % (d.get('headRefOid',''), ','.join(labels))); raise SystemExit
def read(c):
    label=c.get('name') or c.get('context') or c.get('__typename') or 'unnamed'
    if c.get('__typename')=='StatusContext' or ('state' in c and 'conclusion' not in c):
        s=str(c.get('state') or '').upper()
        return label, 'GREEN' if s=='SUCCESS' else 'PENDING' if s in ('PENDING','EXPECTED','') else 'BAD'
    k=str(c.get('conclusion') or '').upper()
    return label, 'PENDING' if not k else 'GREEN' if k in ('SUCCESS','NEUTRAL','SKIPPED') else 'BAD'
read_all=[read(c) for c in rollup]
bad=[l for l,v in read_all if v=='BAD']
pending=[l for l,v in read_all if v=='PENDING']
state='BAD:'+','.join(bad) if bad else 'PENDING:'+','.join(pending) if pending else 'GREEN'
print('%s|%s|%s' % (state, d.get('headRefOid',''), ','.join(labels)))
" 2>"$py_err")
py_code=$?
if [ "$py_code" -ne 0 ] || [ -z "$verdict" ]; then
  said=$(tail -n 1 "$py_err" 2>/dev/null)
  began=$(printf '%s' "$rollup_json" | head -c 120 | tr '\n\t' '  ')
  say "unreadable: the status rollup for ${SLUG}#${PR} did not parse - nothing is known about its checks"
  say "attempted: ${READ_ATTEMPT}"
  say "the reader exited ${py_code} and said: ${said:-nothing on stderr}"
  say "gh returned ${#rollup_json} bytes beginning: ${began}"
  say "This is NOT a red pull request and it was not merged. Retry it in a later round."
  exit 9
fi

state=${verdict%%|*}; rest=${verdict#*|}; rollup_head=${rest%%|*}; labels=${rest#*|}

case "$state" in
  GREEN)     ;;
  EMPTY)     say "not_ready: rollup is empty on ${PR} - no check has registered, which is not a pass"; exit 7 ;;
  PENDING:*) say "not_ready: ${state#PENDING:} on ${PR} has not concluded yet - a check still running is not a failure"; exit 7 ;;
  *)         say "red: ${state#BAD:} failed on ${PR} at ${head_sha}"; exit 4 ;;
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
