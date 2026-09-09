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
  exit 2; }
[ -n "$label" ] || label="environment"
cd "$repo_path" || { echo "! $label: cannot enter $repo_path"; exit 2; }

# mina ships origin/master, so that is what the server must end up serving. Defaulting to
# it means no caller has to substitute a sha into a stored command.
if [ -z "$expect" ]; then
  git fetch origin master --quiet || true
  expect=$(git rev-parse origin/master) || { echo "! $label: cannot resolve origin/master"; exit 2; }
fi

echo "-----> $label: deploying, expecting ${expect:0:8} (timeout ${timeout_s}s)"
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
