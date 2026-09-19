#!/bin/bash
# Build a release train: squash every ready branch onto one branch cut from master, and open a
# single pull request for the lot. Does not merge, does not wait for CI, does not deploy.
#
# WHY. Landing one pull request at a time cost 17.5 minutes each, measured over a 70-minute
# lander run on 2026-08-29 that merged four. Only a third of that was CI. The rest was a rebase
# per branch - because every merge leaves the next branch behind - and a master check per merge.
# The rebase is not waste: it is combination-testing. It is just combination-testing done N times
# at N times the price, with each result discarded the moment master moves again. One branch that
# is tested once keeps the guarantee and pays for it once.
#
# The pull request this opens targets master, so the repository's existing `pull_request` trigger
# runs CI on the MERGE COMMIT - the tree master is about to become, not the train branch head.
# That is a stronger check than anything the per-PR path ever ran, and it needs no workflow
# change and no manual dispatch.
#
# Usage:
#   land-train.sh --repo-path <abs> --slug <owner/name> [--label lane-verified] [--max 8]
#                 [--prefix devloop] [--base master] [--only "635 636 637"]
#
# Exit codes:
#   0  built      train branch pushed, pull request opened. Number is on the last line as PR=<n>.
#   2  empty      nothing carries the label. Nothing was created.
#   5  master_red master was not green. Nothing was touched.
#   6  usage
#
# On conflict a branch is DROPPED from the train and the train continues. It keeps its label and
# is reported on stdout as skipped, so the caller can put it through on its own or hand it back
# for rework. Guessing at a conflict resolution here is how a merge that is green on both sides
# breaks the product.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/git-guard.sh"
PREFIX=devloop
LABEL=lane-verified
MAX=8
ONLY=""
SUFFIX=""
BASE=master
REPO_PATH=""; SLUG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path)
      [ $# -ge 2 ] || { echo "--repo-path needs a value" >&2; exit 6; }
      REPO_PATH="${2:-}"; shift 2 ;;
    --slug)
      [ $# -ge 2 ] || { echo "--slug needs a value" >&2; exit 6; }
      SLUG="${2:-}"; shift 2 ;;
    --label)
      [ $# -ge 2 ] || { echo "--label needs a value" >&2; exit 6; }
      LABEL="${2:-}"; shift 2 ;;
    --max)
      [ $# -ge 2 ] || { echo "--max needs a value" >&2; exit 6; }
      MAX="${2:-}"; shift 2 ;;
    --only)
      [ $# -ge 2 ] || { echo "--only needs a value" >&2; exit 6; }
      ONLY="${2:-}"; shift 2 ;;
    --suffix)
      [ $# -ge 2 ] || { echo "--suffix needs a value" >&2; exit 6; }
      SUFFIX="${2:-}"; shift 2 ;;
    --prefix)
      [ $# -ge 2 ] || { echo "--prefix needs a value" >&2; exit 6; }
      PREFIX="${2:-}"; shift 2 ;;
    --base)
      [ $# -ge 2 ] || { echo "--base needs a value" >&2; exit 6; }
      BASE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done

for req in REPO_PATH SLUG; do
  eval "v=\$$req"
  [ -n "$v" ] || { echo "missing --$(echo "$req" | tr 'A-Z_' 'a-z-')" >&2; exit 6; }
done
case "$MAX" in ''|*[!0-9]*) echo "--max must be a number, got: $MAX" >&2; exit 6 ;; esac
[ -n "$BASE" ] || { echo "--base must name a branch" >&2; exit 6; }
[ -d "$REPO_PATH/.git" ] || { echo "not a git repository: $REPO_PATH" >&2; exit 6; }

cd "$REPO_PATH" || exit 6
git fetch origin --quiet 2>/dev/null

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

github_default=$(timeout "${DEVLOOP_GH_TIMEOUT:-30}" gh repo view "$SLUG" --json defaultBranchRef 2>/dev/null \
  | python3 -c "import json,sys; print((json.load(sys.stdin).get('defaultBranchRef') or {}).get('name') or '')" 2>/dev/null)
if [ -z "$github_default" ]; then
  say "usage: could not read the default branch of ${SLUG} from 'gh repo view ${SLUG} --json defaultBranchRef' within ${DEVLOOP_GH_TIMEOUT:-30}s, so nothing is known about whether ${BASE} is its default - nothing touched"
  exit 6
fi
if [ "$github_default" != "$BASE" ]; then
  say "usage: this train was handed base branch '${BASE}' for ${SLUG} but GitHub says its default branch is '${github_default}' - refusing before any worktree is cut, because the train would be built on one branch and its pull request opened against another. Set repos.<key>.defaultBranch to '${github_default}' in the workspace config"
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

# 1. Master green first. A train built on a break lands the break plus everything else, and then
#    nobody can tell which commit to look at.
master_state=$(gh run list --branch "$BASE" --limit 1 --json status,conclusion 2>/dev/null \
  | python3 -c "
import json,sys
r=json.load(sys.stdin)
print('%s/%s' % (r[0].get('status'), r[0].get('conclusion')) if r else 'none/none')
" 2>/dev/null)
case "$master_state" in
  completed/success) ;;
  *) say "master_red: ${BASE} is $master_state - nothing touched"; exit 5 ;;
esac

# 2. What is ready. Oldest first: a branch that has waited longest has drifted furthest from
#    master and is the most likely to conflict, so it should meet the train while it is empty.
queue=$(gh pr list --repo "$SLUG" --label "$LABEL" --state open \
        --json number,title,headRefName,createdAt --limit 100 2>/dev/null \
  | ONLY="$ONLY" MAX="$MAX" python3 -c "
import json,os,sys
prs=json.load(sys.stdin)
only=[x for x in os.environ.get('ONLY','').replace(',',' ').split() if x]
if only:
    keep=set(only)
    prs=[p for p in prs if str(p['number']) in keep]
prs.sort(key=lambda p: p['createdAt'])
for p in prs[:int(os.environ['MAX'])]:
    print('%s\t%s\t%s' % (p['number'], p['headRefName'], p['title'].replace(chr(9),' ')))
" 2>/dev/null)

[ -n "$queue" ] || { say "empty: no open pull request carries ${LABEL}"; exit 2; }

count=$(printf '%s\n' "$queue" | wc -l | tr -d ' ')
stamp=$(git log -1 --format=%cd --date=format:%Y%m%d-%H%M "origin/${BASE}" 2>/dev/null)
# The suffix exists for bisection. When a train fails and is split, master has NOT moved - the
# train never landed - so both halves compute the same stamp, and two halves of eight are both
# four. Without a distinguishing suffix the second half would silently reuse the first half's
# branch name and its pull request.
TRAIN="release/${stamp}-${count}${SUFFIX:+-$SUFFIX}"
WT="/tmp/${PREFIX}-worktrees/train${SUFFIX:+-$SUFFIX}"

cleanup() {
  cd "$REPO_PATH" 2>/dev/null || return 0
  git worktree remove "$WT" --force >/dev/null 2>/dev/null
  git worktree prune >/dev/null 2>/dev/null
}

git push origin --delete "$TRAIN" >/dev/null 2>/dev/null
git branch -D "$TRAIN" >/dev/null 2>/dev/null
rm -rf "$WT" 2>/dev/null
mkdir -p "/tmp/${PREFIX}-worktrees"
git worktree add --force -b "$TRAIN" "$WT" "origin/${BASE}" >/dev/null 2>/dev/null || {
  say "usage: could not create a worktree for ${TRAIN}"; exit 6; }
cd "$WT" || { cleanup; exit 6; }

say "train ${TRAIN} cut from ${BASE} at $(git rev-parse --short "origin/${BASE}"), ${count} candidate(s)"
say ""

# 3. Squash each branch on. Squash rather than a real merge so master keeps one commit per pull
#    request instead of every intermediate commit a lane made - five, in one case this week.
#
#    The message carries "Closes #<n>" so GitHub retires the pull request itself once the train
#    reaches master. Squashing rewrites the commits, so without that keyword GitHub cannot match
#    them and every pull request would sit open looking unlanded. The caller verifies rather than
#    assuming, because a keyword only fires on merge into the DEFAULT branch.
included=""; skipped=""; body_lines=""; plugin_prs=""
msgfile=$(mktemp "${TMPDIR:-/tmp}/train-msg.XXXXXX")

while IFS="$(printf '\t')" read -r num branch title; do
  [ -n "$num" ] || continue
  squash_ref="origin/${branch}"
  dropped=0
  while [ "$dropped" -lt 20 ]; do
    case "$(git log -1 --format=%s "$squash_ref" 2>/dev/null)" in
      "Set the plugin version "*|"Set devloop plugin version "*) ;;
      *) break ;;
    esac
    parent=$(git rev-parse --verify --quiet "${squash_ref}^1" 2>/dev/null)
    [ -n "$parent" ] || break
    [ "$(git rev-list --count "origin/master..$parent" 2>/dev/null || echo 0)" -ge 1 ] || break
    changed=$(git diff --name-only "$parent" "$squash_ref" 2>/dev/null)
    [ -n "$changed" ] || break
    printf '%s\n' "$changed" \
      | grep -qvE '^(\.claude-plugin/marketplace\.json|plugins/devloop/\.claude-plugin/plugin\.json|plugins/devloop/skills/devloop/CHANGELOG\.md)$' \
      && break
    squash_ref="$parent"
    dropped=$((dropped + 1))
  done
  drop_note=""
  [ "$dropped" = "0" ] || drop_note=" - dropped ${dropped} version commit(s) an earlier round wrote, the train's own number covers it"
  if ! git_with_identity merge --squash "$squash_ref" >/dev/null 2>/dev/null; then
    files=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    git reset --hard HEAD >/dev/null 2>/dev/null
    git clean -fd >/dev/null 2>/dev/null
    say "  skipped #${num} ${branch} - conflicts in: ${files:-unknown}"
    skipped="${skipped}${num} "
    continue
  fi
  if git diff --cached --quiet 2>/dev/null; then
    git reset --hard HEAD >/dev/null 2>/dev/null
    say "  skipped #${num} ${branch} - already on ${BASE}, nothing to add"
    skipped="${skipped}${num} "
    continue
  fi
  printf '%s\n\nCloses #%s\n' "$title" "$num" > "$msgfile"
  git_with_identity commit -q -F "$msgfile" 2>/dev/null || {
    git reset --hard HEAD >/dev/null 2>/dev/null
    say "  skipped #${num} ${branch} - commit refused"
    skipped="${skipped}${num} "
    continue
  }
  say "  added   #${num} ${branch}${drop_note}"
  included="${included}${num} "
  if git show --name-only --format= HEAD 2>/dev/null | grep -qE '^(plugins/|\.claude-plugin/)'; then
    plugin_prs="${plugin_prs}${num} "
  fi
  body_lines="${body_lines}- #${num} ${title}
"
done <<EOF
$queue
EOF

rm -f "$msgfile"

if [ -z "$included" ]; then
  cd "$REPO_PATH" || true; cleanup
  git push origin --delete "$TRAIN" >/dev/null 2>/dev/null
  say ""
  say "empty: every candidate was skipped, no train to open"
  exit 2
fi

if [ -n "$plugin_prs" ]; then
  pr_args=""; pr_list=""
  for num in $plugin_prs; do
    pr_args="${pr_args}--pr ${num} "
    pr_list="${pr_list}#${num} "
  done
  version_out=$(bash "$HERE/assign-plugin-version.sh" --worktree "$WT" --base "origin/${BASE}" --slug "$SLUG" $pr_args 2>/dev/null)
  version_code=$?
  case "$version_code" in
    0|2) say ""
         say "version: $(printf '%s\n' "$version_out" | head -1)" ;;
    *) cd "$REPO_PATH" || true; cleanup
       git push origin --delete "$TRAIN" >/dev/null 2>/dev/null
       say ""
       say "usage: the devloop plugin version could not be assigned to ${TRAIN}, whose plugin change(s) are ${pr_list% } - ${version_out:-assign-plugin-version.sh printed nothing}"
       exit 6 ;;
  esac
fi

# 4. Push and open the pull request. Guard the push: this is not a default branch and the guard
#    proves it rather than trusting that the cd above went where it was meant to.
guard_err=$(mktemp "${TMPDIR:-/tmp}/guard-err.XXXXXX")
bash "$GUARD" --dir="$WT" --branch="$TRAIN" --default="$BASE" -- git push -u origin "$TRAIN" >/dev/null 2>"$guard_err"
guard_rc=$?
if [ "$guard_rc" != 0 ]; then
  verdict=$(guard_verdict "$guard_rc" "$guard_err" "push -u origin ${TRAIN}" "$TRAIN")
  rm -f "$guard_err"
  cd "$REPO_PATH" || true; cleanup
  say "$verdict"; exit 6
fi
rm -f "$guard_err"

bodyfile=$(mktemp "${TMPDIR:-/tmp}/train-body.XXXXXX")
{
  printf 'Squashed onto one branch cut from %s so the whole set is tested together rather\n' "$BASE"
  printf 'than each part being tested against a %s it never lands on unchanged.\n\n' "$BASE"
  printf 'This pull request targets %s, so the checks below run against the merge commit -\n' "$BASE"
  printf 'the tree %s becomes if this lands, not the branch head.\n\n' "$BASE"
  printf 'Included:\n\n%s' "$body_lines"
  if [ -n "$skipped" ]; then
    printf '\nHeld back, still labelled and still open: '
    printf '%s\n' "$skipped"
    printf 'These conflicted with something already on the train, or had nothing left to add.\n'
  fi
} > "$bodyfile"

pr_url=$(gh pr create --repo "$SLUG" --base "$BASE" --head "$TRAIN" \
  --title "Release ${stamp}: $(echo "$included" | wc -w | tr -d ' ') change(s)" \
  --body-file "$bodyfile" 2>/dev/null)
rm -f "$bodyfile"

cd "$REPO_PATH" || true
cleanup

if [ -z "$pr_url" ]; then
  say "usage: the train branch pushed but the pull request could not be opened"
  exit 6
fi

train_pr=$(printf '%s' "$pr_url" | sed 's#.*/##')

say ""
say "built: ${TRAIN} -> ${pr_url}"
say "included: ${included}"
[ -n "$skipped" ] && say "skipped:  ${skipped}"
say ""
say "Wait for its checks, then merge it. Show the evidence before merging:"
say "  gh pr checks ${train_pr} --repo ${SLUG} --watch --fail-fast"
say "  gh pr view ${train_pr} --repo ${SLUG} --json statusCheckRollup"
say "PR=${train_pr}"
exit 0
