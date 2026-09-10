#!/usr/bin/env bash
# Deploy ONE environment and decide the outcome by reading the server, not by trusting
# the deploy tool's exit code.
#
# WHY. On 2026-09-04 (app-1lw7) a 'mina staging deploy' finished completely on the server
# - lock removed, current symlink moved, revisions.log written - and then did not return
# locally, because mina allocates a TTY with -tt and the session did not close. Both
# landers run the two environments in sequence, so a staging deploy that never returns
# means PRODUCTION IS NEVER ATTEMPTED and nothing reports an error, since staging really
# did succeed. That leaves staging ahead of production with no failure anywhere, which is
# the one split this project forbids outright: the extension has an environment switcher,
# so a change live in only one of them is live in neither as far as a tester is concerned.
#
# THE RULE, IN BOTH DIRECTIONS. The server read is the verdict and the exit code is only
# advice:
#   killed by the timeout + server IS at the sha  -> success, carry on to the next
#   exited 0 cleanly       + server is NOT at it  -> failure, however happy the tool looked
set -u

label=""; repo_path="."; deploy_cmd=""; revision_cmd=""; expect=""; timeout_s=1800
while [ $# -gt 0 ]; do
  case "$1" in
    --label)     label=$2;       shift 2 ;;
    --repo-path) repo_path=$2;   shift 2 ;;
    --deploy)    deploy_cmd=$2;  shift 2 ;;
    --revision)  revision_cmd=$2;shift 2 ;;
    --expect)    expect=$2;      shift 2 ;;
    --timeout)   timeout_s=$2;   shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$deploy_cmd" ] && [ -n "$revision_cmd" ] || {
  echo "usage: deploy-one.sh --label staging --repo-path DIR --deploy CMD --revision CMD [--expect SHA] [--timeout SEC]" >&2
  echo "       --repo-path is the repository the deploy worktree is cut FROM; the deploy itself" >&2
  echo "       runs in a throwaway worktree at origin/master, never in that working tree." >&2
  exit 2; }
[ -n "$label" ] || label="environment"
cd "$repo_path" || { echo "! $label: cannot enter $repo_path"; exit 2; }
repo_path=$(pwd)

git fetch origin master --quiet || {
  echo "! $label: cannot fetch origin/master in $repo_path - refusing rather than deploying"
  echo "! from a ref that may be stale, which is the failure this worktree exists to prevent."
  exit 2; }
master=$(git rev-parse origin/master) || { echo "! $label: cannot resolve origin/master"; exit 2; }

# mina ships origin/master, so that is what the server must end up serving. Defaulting to
# it means no caller has to substitute a sha into a stored command.
[ -n "$expect" ] || expect=$master

work_parent=""; work_tree=""
cleanup() {
  trap_rc=$?
  cd /
  [ -n "$work_tree" ] && git -C "$repo_path" worktree remove --force "$work_tree" >/dev/null 2>/dev/null
  [ -n "$work_parent" ] && rm -rf "$work_parent"
  exit "$trap_rc"
}
trap cleanup EXIT

git -C "$repo_path" worktree prune >/dev/null 2>/dev/null
work_parent=$(mktemp -d "${TMPDIR:-/tmp}/deploy-one-XXXXXX") || { echo "! $label: cannot create a scratch directory for the deploy worktree"; exit 2; }
work_tree="$work_parent/src"
git -C "$repo_path" worktree add --detach "$work_tree" "$master" --quiet || {
  echo "! $label: cannot cut a worktree at ${master:0:8} from $repo_path"; exit 2; }
cd "$work_tree" || { echo "! $label: cannot enter $work_tree"; exit 2; }

echo "-----> $label: deploying from a worktree at ${master:0:8}, expecting ${expect:0:8} (timeout ${timeout_s}s)"
timeout "$timeout_s" bash -c "$deploy_cmd" < /dev/null
rc=$?
[ "$rc" -eq 124 ] && echo "-----> $label: deploy command hit the ${timeout_s}s timeout and was killed - asking the server what it is serving"
[ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && echo "-----> $label: deploy command exited $rc - asking the server anyway, the exit code is not the verdict"

actual=$(bash -c "$revision_cmd" < /dev/null | tr -d '[:space:]')
shown=${actual:0:8}; [ -n "$shown" ] || shown="nothing"
echo "-----> $label: server is serving $shown"

if [ "$actual" = "$expect" ]; then
  [ "$rc" -eq 0 ] && echo "OK $label at ${expect:0:8}" || echo "OK $label at ${expect:0:8} (the deploy finished on the server even though the local command exited $rc)"
  exit 0
fi

echo "! FAILED $label: expected ${expect:0:8}, server has $shown (local exit $rc)"
if [ "$rc" -eq 124 ]; then
  echo "! the deploy was killed mid-flight, so its remote cleanup may not have run and a"
  echo "! deploy.lock may still be on the server. The next deploy will refuse with"
  echo "! 'another deployment is ongoing' until that is cleared."
fi
exit 1
