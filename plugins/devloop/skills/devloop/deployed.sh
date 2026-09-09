#!/bin/bash
# How far ahead of the servers is master, and what is sitting in the gap.
#
# WHY. 'Landed' and 'live' are different claims, and nothing in this pipeline distinguishes them.
# A train merges, confirms master green, and only then deploys - so between those two moments the
# code is on master, CI is green, the tracker says landed, and the site does not have it. On
# 2026-08-30 the owner hit /tools/webhook-test, got a 404, and asked what was wrong. Nothing was:
# the deploy was still running. But the only way to find that out was to try the page.
#
# The gap also outlives a run. A train that merges and then fails, or is stopped, leaves master
# ahead with nothing scheduled to close it, and the next train only deploys what IT lands - so an
# earlier commit can sit undeployed indefinitely while everything looks finished.
#
# Usage:  deployed.sh
# Exit:   0 in step, 1 behind, 2 could not read a host. This reports; deploying is a train's job.

set -u

# NO DEFAULT ROOT. This reports WHAT IS LIVE, which makes a wrong answer worse than a missing
# one: run from another workspace it reported one workspace's revision as "in step" across
# master, staging and production, exit 0, with nothing saying the root had been defaulted -
# an answer about a third project entirely. Found on 2026-09-09 by running it, not reading it.
ROOT="${DEVLOOP_ROOT:-$PWD}"
if [ ! -d "$ROOT/.beads" ]; then
  echo "deployed.sh: no .beads tracker at $ROOT - refusing." >&2
  echo "             It would otherwise report another project's deployed revision as yours." >&2
  echo "             Run from the workspace root, or set DEVLOOP_ROOT." >&2
  exit 3
fi
REPO="$ROOT/site"
HOST="${DEVLOOP_DEPLOY_HOST:-deploy@your-server}"

cd "$REPO" 2>/dev/null || { echo "not a directory: $REPO" >&2; exit 2; }
git fetch origin --quiet 2>/dev/null

master=$(git rev-parse origin/master 2>/dev/null)
[ -n "$master" ] || { echo "could not read origin/master" >&2; exit 2; }

revs=$(timeout 25 ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  'for e in production staging; do echo -n "$e "; cat /home/deploy/your-app/$e/current/.mina_git_revision 2>/dev/null; echo; done' 2>/dev/null)

[ -n "$revs" ] || { echo "could not reach $HOST - say so rather than assuming it is in step" >&2; exit 2; }

behind=0
printf '%-12s %-10s %s\n' "where" "revision" "state"
printf '%-12s %-10s %s\n' "-----" "--------" "-----"
printf '%-12s %-10s %s\n' "master" "${master:0:8}" "-"

while read -r env rev; do
  [ -n "$rev" ] || continue
  if [ "$rev" = "$master" ]; then
    printf '%-12s %-10s %s\n' "$env" "${rev:0:8}" "in step"
  else
    n=$(git rev-list --count "$rev..$master" 2>/dev/null || echo "?")
    printf '%-12s %-10s %s\n' "$env" "${rev:0:8}" "BEHIND by $n commit(s)"
    behind=1
  fi
done <<EOF
$(printf '%s\n' "$revs")
EOF

if [ "$behind" = "1" ]; then
  echo
  echo "Undeployed on master:"
  first=$(printf '%s\n' "$revs" | awk 'NF>1 {print $2; exit}')
  git log --oneline "$first..$master" 2>/dev/null | sed 's/^/  /'
  echo
  echo "A train deploys only what IT lands, so this does not close itself. Run one - it will"
  echo "deploy the whole of master, not just its own passengers - or deploy by hand from ${REPO}:"
  echo "  bash ~/.claude/skills/devloop/deploy-one.sh --label staging --repo-path ${REPO} --deploy 'bundle exec mina staging deploy' --revision \"ssh deploy@your-server 'cat /home/deploy/your-app/staging/current/.mina_git_revision'\""
  echo "  bash ~/.claude/skills/devloop/deploy-one.sh --label production --repo-path ${REPO} --deploy 'bundle exec mina production deploy' --revision \"ssh deploy@your-server 'cat /home/deploy/your-app/production/current/.mina_git_revision'\""
  echo
  echo "One environment per command, staging first, and stop if staging does not exit 0. Do not"
  echo "chain them with '&&': mina can finish on the server and still hang locally, which leaves"
  echo "production silently a release behind (app-1lw7). deploy-one.sh reads the sha back off the"
  echo "server and that read, not mina's exit code, is the verdict."
  exit 1
fi

echo
echo "master, staging and production agree - what is landed is live."
exit 0
