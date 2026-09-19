#!/bin/bash
# Hand a finished branch to the lander: check compliance, label, clean up, record. One command
# instead of the ten every lane runs by hand.
#
# WHY. A tool call costs about 2,200 tokens in a lane whatever it runs - that is accumulated
# context re-sent each turn, not the size of the output. Measured across ten lane runs on
# 2026-08-27: 2,436 calls, 5.36M tokens. So the way to spend fewer tokens is to make fewer
# calls, and the handoff is the most mechanical block a lane has: read the body back, read the
# commit messages back, grep both, label, read the label back, remove the worktree, confirm it
# is gone, append a tracker note, read that back, drop the lane lock.
#
# IT REFUSES TO LABEL A NON-COMPLIANT BRANCH, and that is the point of doing it here rather
# than trusting each lane to remember. The label is an assertion that the PR is ready; a PR
# whose body or commits mention tooling is not ready, and labelling it first and fixing it
# after is how something reaches master with the wrong text in it.
#
# Usage:
#   lane-handoff.sh --repo-path <abs> --slug <owner/name> --pr <n> --branch <name> \
#                   --issue <app-xxxx> --note-file <path> [--worktree <abs>] [--lane-lock <abs>]
#                   [--label lane-verified] [--check-only] [--base master]
#
#   lane-handoff.sh --repo-path <abs> --pre-push [--rebased] [--branch <name>] [--base master]
#
#   Other open pull requests on --branch, across the repositories the workspace config names, are
#   derived and handled in the same invocation.
#
# Exit codes:
#   0  handed off    every pull request on the branch compliant and labelled, cleaned up, note
#                    recorded and read back. Under --pre-push: the commit range is clear.
#   2  non-compliant NOTHING was labelled anywhere. The offending lines are printed against the
#                    pull request they came from. Fix, then re-run.
#                    Under --pre-push there is no pull request and the range is graded per commit:
#                    a hit in a commit the remote does not hold prints the amend or squash to run,
#                    and one in a commit it does hold prints no remedy at all, because every route
#                    out of that state rewrites published history. Report which commit and stop.
#                    --rebased narrows that to the top commit, since a rebase renews every sha and
#                    the commits underneath it were reviewed as they stand.
#   3  conflicted    a pull request on the branch conflicts with master, so GitHub scheduled no
#                    checks for it at all and none are coming. Nothing was labelled anywhere.
#                    The remedy is a merge from master and a push, not another wait.
#   4  not-green     a pull request on the branch is not in a state to label (empty rollup with
#                    no conflict to explain it, a failing check). Nothing was labelled anywhere.
#   5  note-unconfirmed  labelled and cleaned up, but the tracker note could not be confirmed.
#                    Do not re-run - repair the note only.
#   6  usage         bad arguments. Nothing was read and nothing was labelled.
#   7  not-surveyed  the set of pull requests on the branch could not be established, or the
#                    label could not be prepared in one of the repositories holding them, or
#                    one of their texts could not be read, or GitHub would not say what sha the
#                    branch is at. Nothing was labelled anywhere.
#                    Under --pre-push: the remote would not say whether the branch exists at all,
#                    which is not the same as it not existing - reading silence as absence is how
#                    an amend gets printed for a branch a plain push cannot reach.
#                    Fix what it names, then re-run.
#   8  half-labelled labelling began and could not be finished. It prints which pull requests
#                    carry the label and which do not. Adding a label is idempotent and this
#                    exits before the worktree removal and the tracker note, so re-run it once
#                    the cause is gone rather than labelling the rest by hand.
#   9  unreadable    the status rollup of a pull request on the branch could not be READ at all -
#                    a throttled or failing gh, or output that did not parse. Nothing is known
#                    about its checks, which is not the same as knowing they failed, so this is
#                    never reported as 4. Nothing was labelled anywhere. It names the exact
#                    'gh api' read it attempted and what gh or the reader said. Retry the read.
#  10  published-rewritten  --pre-push without --rebased. The branch exists on the remote and HEAD
#                    does not contain the head it holds, so it was published and then rewritten and
#                    no plain push will be accepted. Every commit message graded clear - there is
#                    simply no plain push here to clear, and publishing this HEAD needs a person.

set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL=lane-verified
REPO_PATH=""; SLUG=""; PR=""; BRANCH=""; ISSUE=""; NOTE_FILE=""; WT=""; LOCK=""; CHECK_ONLY=0
PRE_PUSH=0; REBASED=0; BASE=master

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
    --issue)
      [ $# -ge 2 ] || { echo "--issue needs a value" >&2; exit 6; }
      ISSUE="${2:-}"; shift 2 ;;
    --note-file)
      [ $# -ge 2 ] || { echo "--note-file needs a value" >&2; exit 6; }
      NOTE_FILE="${2:-}"; shift 2 ;;
    --worktree)
      [ $# -ge 2 ] || { echo "--worktree needs a value" >&2; exit 6; }
      WT="${2:-}"; shift 2 ;;
    --lane-lock)
      [ $# -ge 2 ] || { echo "--lane-lock needs a value" >&2; exit 6; }
      LOCK="${2:-}"; shift 2 ;;
    --label)
      [ $# -ge 2 ] || { echo "--label needs a value" >&2; exit 6; }
      LABEL="${2:-}"; shift 2 ;;
    --base)
      [ $# -ge 2 ] || { echo "--base needs a value" >&2; exit 6; }
      BASE="${2:-}"; shift 2 ;;
    --check-only) CHECK_ONLY=1;      shift 1 ;;
    --pre-push)  PRE_PUSH=1;         shift 1 ;;
    --rebased)   REBASED=1;         shift 1 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done
[ -n "$BASE" ] || { echo "--base must name a branch" >&2; exit 6; }
if [ "$PRE_PUSH" = "1" ]; then
  [ -n "$REPO_PATH" ] || { echo "missing --repo-path" >&2; exit 6; }
else
  [ "$REBASED" = "0" ] || { echo "--rebased only means anything with --pre-push" >&2; exit 6; }
  for req in REPO_PATH SLUG PR BRANCH; do
    eval "v=\$$req"; [ -n "$v" ] || { echo "missing --$(echo "$req" | tr 'A-Z_' 'a-z-')" >&2; exit 6; }
  done
  case "$PR" in ''|*[!0-9]*) echo "--pr must be a number, got: $PR" >&2; exit 6 ;; esac
fi

if [ -n "$NOTE_FILE" ]; then
  [ -n "$ISSUE" ] || {
    echo "lane-handoff.sh: --note-file was given without --issue, so the note has nowhere to go." >&2
    echo "                 Pass both or neither. Nothing was labelled." >&2
    exit 6; }
  note_dir=$(cd "$(dirname "$NOTE_FILE")" 2>/dev/null && pwd)
  [ -n "$note_dir" ] && NOTE_FILE="$note_dir/$(basename "$NOTE_FILE")"
  [ -f "$NOTE_FILE" ] || {
    echo "lane-handoff.sh: --note-file ${NOTE_FILE} does not exist, so the note could not be" >&2
    echo "                 recorded. Nothing was labelled. Write the file, then run this again." >&2
    exit 6; }
fi

cd "$REPO_PATH" 2>/dev/null || { echo "not a directory: $REPO_PATH" >&2; exit 6; }

git fetch origin --quiet 2>/dev/null

# THE SLUG MUST BE REAL, and it is derived here rather than trusted.
#
# On 2026-09-08 --slug arrived as the literal string "undefined" from the orchestrator. The
# chain that follows is the worst failure this script has: `gh pr view --repo undefined`
# fails, the compliance grep below then runs over an EMPTY body, an empty body contains no
# authorship language, and the gate REPORTS COMPLIANT HAVING READ NOTHING.
#
# It was noticed only because the label step failed afterwards - and six of thirteen lanes
# that day hand-labelled after a failed label step, so the noticing is not reliable either.
# The thing standing between an authorship mention and a public repository would simply not
# have run.
#
# The repository knows its own slug. Ask it, and only fall back to what was passed.
if [ "$PRE_PUSH" != "1" ]; then
derived=$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null \
          | sed -e 's#\.git$##' -e 's#^git@github\.com:##' -e 's#^https://github\.com/##')
case "$derived" in */*) SLUG="$derived" ;; esac
case "$SLUG" in
  ''|undefined|null|*/*) : ;;
  *) echo "lane-handoff.sh: --slug is not owner/name and could not be derived: '$SLUG'" >&2; exit 6 ;;
esac
case "$SLUG" in ''|undefined|null)
  echo "lane-handoff.sh: no usable repository slug - refusing to run the compliance check." >&2
  echo "                 An empty read is not a clean read." >&2
  exit 6 ;;
esac
fi


# FIND THE TRACKER, DO NOT ASSUME ITS DEPTH. This used to be a flat `cd "$REPO_PATH/.."`,
# which encodes one workspace shape: a parent directory holding several repositories, as in
# one workspace. In a SINGLE-repo workspace the workspace root IS the
# repository, so that parent is one level too high, has no .beads, and every append fails with
# "no beads database found". Measured on 2026-09-05: two lanes in a row reported exactly
# that, noticed it themselves and re-ran bd by hand. Same class as the lockPrefix and slug
# defaults - a project-specific assumption baked into a shared script, wrong for the second
# project and quiet about it. Walk up instead, and keep the old parent as the last resort so
# nothing that worked before changes behaviour.
ROOT_DIR=""
probe="$REPO_PATH"
for _ in 1 2 3 4 5; do
  probe=$(cd "$probe" && pwd) || break
  if [ -d "$probe/.beads" ]; then ROOT_DIR="$probe"; break; fi
  [ "$probe" = "/" ] && break
  probe="$probe/.."
done
[ -n "$ROOT_DIR" ] || ROOT_DIR=$(cd "$REPO_PATH/.." && pwd)

CFG_ROOT=$(bash "$SKILL_DIR/config.sh" root 2>/dev/null) || CFG_ROOT=""
[ -n "$CFG_ROOT" ] && [ -d "$CFG_ROOT" ] || CFG_ROOT="$ROOT_DIR"

TAB=$(printf '\t')

# WHAT THIS ACTUALLY TESTS: does the text CLAIM the change was made, assisted or co-authored by
# an AI. That is the whole of the rule. It is not a ban on the words 'AI', 'agent' or
# 'assistant' appearing.
#
# The distinction matters here more than most places, because this product SHIPS an AI assistant
# - it is the label on a button, config/locales/en.yml 'label: AI assistant' - so the words are
# in the DOM ids, the field names, the locale keys and any honest description of that screen.
# A word list flagged all of it. On 2026-08-29 it refused a spec fix about a Bootstrap collapse
# whose only sin was naming the panel it was fixing, and a lane overrode the refusal rather than
# stopping, which is a worse outcome than the false positive itself.
#
# So this matches AUTHORSHIP PHRASINGS, not vocabulary: generated/written/created/authored by or
# with an AI, co-authored-by trailers, 'AI-assisted', 'with the help of AI'. Plus the three
# vendor names, which have no innocent reason to appear in a commit message about this codebase.
#
# The second group is different and stays: it catches the PIPELINE leaking into public text -
# worktree paths, lane labels, /tmp. Not an authorship claim, but nothing a reader should see,
# and it has never once fired falsely.
# 'generated with|by' NEEDS AN AGENT AFTER IT. Bare 'generated by' matched
# 'generated by script/marketing/shots.mjs' and 'the file is generated from cable.yml.template' -
# ordinary engineering English describing a build step, twice on 2026-08-30, and a lane overrode
# the refusal each time. What the rule forbids is claiming a MACHINE AUTHOR, so the pattern names
# the authors it means. 'Generated with Claude Code' is still caught, by this clause and by the
# bare vendor names below.
authorship='(co-?authored-?by|generated (with|by) (an? )?(ai|claude|copilot|assistant|agent|bot|llm|chatgpt|gpt)|written by (an? )?(ai|assistant|agent|claude|copilot|bot)|created by (an? )?(ai|assistant|agent)|authored by (an? )?(ai|assistant|agent)|ai[- ](assisted|generated|written|authored)|assisted by (an? )?(ai|assistant|agent)|with the help of (an? )?ai|\bclaude\b|\banthropic\b|\bcopilot\b)'
# 'worktree' ALONE IS NOT A LEAK. It is a core git feature, and a commit that explains path
# handling or checkout behaviour may name it in ordinary engineering English. On 2026-08-31 this
# refused site#892 over the sentence 'a run driven from a worktree does not write into whichever
# checkout the relative path happens to resolve to', which tells a reader nothing except that git
# worktrees exist. The branch was green and made no authorship claim, and it stopped dead, because
# a lane rightly will not amend a pushed history unattended. A real worktree leak is a PATH, and
# every path this pipeline uses is already caught by devloop, /tmp/ or /private/tmp.
leakage='(devloop|lane-verified|/tmp/|/private/tmp)'

# CLAUDE.md and AGENTS.md are FILES IN THESE REPOSITORIES. Referring to one - 'what
# site/CLAUDE.md says about lazy lookups' - names a documentation file, exactly as naming
# Gemfile or schema.rb would. It is not a claim about who wrote the code, and it tripped
# \bclaude\b on 2026-08-29. Neutralised before the test rather than excused after it.
neutral='s#[A-Za-z/._-]*CLAUDE\.md#REPO-DOC#g; s#[A-Za-z/._-]*AGENTS\.md#REPO-DOC#g; s#\.claude-plugin#DOT-PLUGIN-DIR#g; s#plugins/devloop#PLUGIN-DIR#g; s#skills/devloop#SKILL-DIR#g'
plugin_name='s#[Dd][Ee][Vv][Ll][Oo][Oo][Pp]#PLUGIN-NAME#g'

neutral_for() {
  if [ -f "$1/plugins/devloop/skills/devloop/$(basename "${BASH_SOURCE[0]}")" ]; then
    printf '%s; %s' "$neutral" "$plugin_name"
  else
    printf '%s' "$neutral"
  fi
}

if [ "$PRE_PUSH" = "1" ]; then
  git rev-parse --verify --quiet "origin/${BASE}" >/dev/null || {
    echo "lane-handoff.sh: no origin/${BASE} in ${REPO_PATH}, so there is no range to check." >&2
    exit 6; }

  range=$(git rev-list "origin/${BASE}..HEAD" 2>/dev/null)
  if [ -z "$range" ]; then
    echo "lane-handoff.sh: HEAD is not ahead of origin/${BASE} in ${REPO_PATH} - nothing was read," >&2
    echo "                 so nothing was checked. Commit first, then run this again." >&2
    exit 6
  fi

  tip=$(git rev-parse HEAD)

  PRE_BRANCH=""; rewritten=0; head_absent=0; pushed_tip=""; short_remote=""

  if [ "$REBASED" = "1" ]; then
    unpushed="$range"
  else
    PRE_BRANCH="$BRANCH"
    if [ -z "$PRE_BRANCH" ]; then
      PRE_BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null) || PRE_BRANCH=""
    fi
    if [ -z "$PRE_BRANCH" ]; then
      echo "lane-handoff.sh: HEAD is detached and no --branch was given, so the remote cannot be" >&2
      echo "                 asked whether this branch is published - and that is what decides" >&2
      echo "                 whether an amend here is free or needs a force-push nobody may run." >&2
      echo "                 Nothing was graded. Pass --branch <name>, or run this on the branch." >&2
      exit 6
    fi

    if remote_refs=$(git ls-remote --heads origin "refs/heads/${PRE_BRANCH}" 2>/dev/null); then
      :
    else
      echo "lane-handoff.sh: 'git ls-remote --heads origin refs/heads/${PRE_BRANCH}' failed in" >&2
      echo "                 ${REPO_PATH}, so whether the branch is published is unknown. Unknown is" >&2
      echo "                 not local: taken as local it prints an amend and a squash the push then" >&2
      echo "                 refuses. Nothing was graded. Restore access to the remote and re-run." >&2
      exit 7
    fi
    remote_head=$(printf '%s\n' "$remote_refs" | awk 'NF {print $1; exit}')

    if [ -n "$remote_head" ]; then
      short_remote=$(git rev-parse --short "$remote_head" 2>/dev/null)
      [ -n "$short_remote" ] || short_remote="$remote_head"
      if git cat-file -e "${remote_head}^{commit}" 2>/dev/null; then
        if git merge-base --is-ancestor "$remote_head" HEAD 2>/dev/null; then
          pushed_tip="$remote_head"
        else
          rewritten=1
        fi
      else
        rewritten=1
        head_absent=1
      fi
    fi

    if [ "$rewritten" = "1" ]; then
      unpushed=""
    elif [ -n "$pushed_tip" ]; then
      unpushed=$(git rev-list "${pushed_tip}..HEAD" 2>/dev/null)
    else
      unpushed="$range"
    fi
  fi

  local_hits=""; remote_hits=""; deep_hits=""; rewritten_hits=""
  repo_neutral=$(neutral_for "$REPO_PATH")
  for sha in $range; do
    hit=$(git log -1 --format='%B%n%an <%ae>%n%(trailers)' "$sha" 2>/dev/null \
      | sed "$repo_neutral" \
      | grep -inE "$authorship|$leakage" \
      | head -5)
    [ -n "$hit" ] || continue
    entry="  $(git log -1 --format='%h %s' "$sha")
$(printf '%s\n' "$hit" | sed 's/^/    /')
"
    if [ "$REBASED" = "1" ] && [ "$sha" != "$tip" ]; then
      deep_hits="${deep_hits}${entry}"
    elif [ "$rewritten" = "1" ]; then
      rewritten_hits="${rewritten_hits}${entry}"
    elif printf '%s\n' "$unpushed" | grep -qx "$sha"; then
      local_hits="${local_hits}${entry}"
    else
      remote_hits="${remote_hits}${entry}"
    fi
  done

  if [ -n "$remote_hits" ] || [ -n "$deep_hits" ] || [ -n "$rewritten_hits" ]; then
    echo "non-compliant commits: A HIT IN ONE OF THESE NEEDS A PERSON."
    if [ -n "$rewritten_hits" ]; then
      echo "The remote holds ${PRE_BRANCH} at ${short_remote} and HEAD does not contain it, so the"
      echo "branch was published and then rewritten. No plain push is accepted from here and no"
      echo "amend made here reaches what is already published:"
      printf '%s' "$rewritten_hits"
      if [ "$head_absent" = "1" ]; then
        echo "That published head is not in this checkout, so what it carries could not be read here"
        echo "either - which is one more reason this is not a state to push out of."
      fi
    fi
    if [ -n "$remote_hits" ]; then
      echo "Already reachable from a remote ref, so rewording it rewrites history somebody else's"
      echo "ref points at:"
      printf '%s' "$remote_hits"
    fi
    if [ -n "$deep_hits" ]; then
      echo "Underneath the top commit. The branch was rebased, so these carry new shas and so"
      echo "read as unpushed, but their messages were reviewed and are not yours to rewrite:"
      printf '%s' "$deep_hits"
    fi
    if [ -n "$local_hits" ]; then
      echo "And these, in the top commit:"
      printf '%s' "$local_hits"
    fi
    echo ""
    echo "REPORT WHICH COMMIT AND STOP. No amend and no squash is offered here, deliberately:"
    echo "every route to a clean message from this state rewrites a commit something already"
    echo "relies on, and a squash that reaches one of them is worse than the message it clears."
    echo "Name the commit in your notes and return blocked."
    if [ -n "$remote_hits" ] || [ -n "$rewritten_hits" ]; then
      echo "The moment it was fixable was before that commit was pushed, which is what running this"
      echo "check first buys you."
    fi
    if [ -n "$deep_hits" ]; then
      echo "A message underneath came from the branch as it was reviewed, so no step here owns it."
    fi
    exit 2
  fi

  if [ -n "$local_hits" ]; then
    if [ "$REBASED" = "1" ]; then
      echo "non-compliant commits: the hit is in the top commit, which is not pushed yet."
      echo "Offending lines:"
    elif [ -n "$pushed_tip" ]; then
      echo "non-compliant commits: the remote holds ${PRE_BRANCH} at ${short_remote} and every hit is"
      echo "above it. Offending lines:"
    else
      echo "non-compliant commits: nothing has been pushed - the remote has no ${PRE_BRANCH} at all."
      echo "Offending lines:"
    fi
    printf '%s' "$local_hits"
    echo ""
    echo "Fix them NOW, while these commits are still local - this is the only moment a commit"
    echo "message is cheap to change. Once pushed it takes a force-push, which a lane may not run,"
    echo "and the pull request is then green and unlandable until a person rewrites the history."
    echo "CARRY THE IDENTITY ON THE COMMAND, exactly as the commit you are replacing did. A lane"
    echo "resolves no git identity of its own, and the failure is not reliably loud: git either"
    echo "refuses outright or stamps a hostname-derived name and address, which then lands on"
    echo "master and which no grep here reads. Take it from the branch you are building on:"
    echo "  the tip commit only:"
    echo "    git -c user.name=\"\$(git log -1 --format=%an origin/${BASE})\" -c user.email=\"\$(git log -1 --format=%ae origin/${BASE})\" commit --amend -F <a file holding the new message>"
    if [ "$REBASED" = "1" ]; then
      echo "THAT AMEND IS THE ONLY REMEDY IN THIS MODE, and it is for the top commit alone."
      echo "There is deliberately no squash: the commits underneath were reviewed as they stand,"
      echo "and a rebase having renewed their shas does not make them yours."
    elif [ -n "$pushed_tip" ]; then
      echo "  anything deeper:"
      echo "    git reset --soft ${short_remote} && git -c user.name=\"\$(git log -1 --format=%an origin/${BASE})\" -c user.email=\"\$(git log -1 --format=%ae origin/${BASE})\" commit -F <a file>"
      echo "THAT BASE IS THE HEAD THE REMOTE HOLDS FOR ${PRE_BRANCH}, not origin/${BASE}. Resetting"
      echo "past it would collapse the commits the remote branch is built on, and the push after it"
      echo "is refused as a non-fast-forward - which leaves only a force-push, which you may not run."
    else
      echo "  anything deeper:"
      echo "    git reset --soft origin/${BASE} && git -c user.name=\"\$(git log -1 --format=%an origin/${BASE})\" -c user.email=\"\$(git log -1 --format=%ae origin/${BASE})\" commit -F <a file>"
      echo "Squashing costs nothing here: the remote has no such branch, so no commit on it has been"
      echo "published, and the train squashes the branch when it lands anyway."
    fi
    echo "Judge each hit. A vendor or product name that is the SUBJECT of the change is fine;"
    echo "the label the lander reads is not, so name it in prose instead of quoting its token."
    echo "THEN RUN THIS AGAIN, before you push. The message you have just written is the one"
    echo "nobody has re-read, and a reword that only moved the hit looks identical to a fix"
    echo "until this exits 0."
    exit 2
  fi

  if [ "$rewritten" = "1" ]; then
    echo "published-rewritten: every commit message in origin/${BASE}..HEAD is clear, and this is"
    echo "still not a push you can make. The remote holds ${PRE_BRANCH} at ${short_remote}, which"
    echo "HEAD does not contain, so the branch was published and then rewritten: a plain push is"
    echo "refused as a non-fast-forward and the only way on rewrites what the remote already holds."
    if [ "$head_absent" = "1" ]; then
      echo "That published head is not in this checkout either, so nothing here can say what it"
      echo "carries."
    fi
    echo "THIS IS THE CASE A PERSON APPROVES, and it is not a clean check: the messages are clear,"
    echo "the push is not. Say in your notes that ${PRE_BRANCH} is published at ${short_remote} and"
    echo "that HEAD rewrites it, and return blocked. Do not reach for a force-push."
    exit 10
  fi

  echo "compliant commits: origin/${BASE}..HEAD in ${REPO_PATH} is clear - safe to push"
  exit 0
fi

REST_TRIES="${LANE_HANDOFF_REST_TRIES:-5}"
REST_BACKOFF="${LANE_HANDOFF_REST_BACKOFF:-5}"
case "$REST_TRIES" in ''|*[!0-9]*|0) REST_TRIES=1 ;; esac
case "$REST_BACKOFF" in ''|*[!0-9]*) REST_BACKOFF=5 ;; esac

gh_rest() {
  local _out="$1" _err="$2" _try=1 _rc _wait
  shift 2
  while :; do
    gh api "$@" >"$_out" 2>"$_err"; _rc=$?
    [ "$_rc" -eq 0 ] && return 0
    [ "$_try" -lt "$REST_TRIES" ] || return "$_rc"
    grep -qiE 'rate limit|secondary rate|abuse detection|HTTP 429' "$_err" || return "$_rc"
    _wait=$(( REST_BACKOFF << (_try - 1) ))
    echo "lane-handoff.sh: gh api $* was rate limited on attempt ${_try} of ${REST_TRIES} - waiting ${_wait}s" >&2
    sleep "$_wait"
    _try=$((_try + 1))
  done
}

# 1. COMPLIANCE, read back from where the text is actually stored rather than from what anybody
#    meant to write. GitHub and git both add and rewrite text.
check_one() {
  local box rc
  box=$(mktemp -d "${TMPDIR:-/tmp}/lane-handoff-check.XXXXXX")
  check_one_in "$box" "$@"; rc=$?
  rm -rf "$box"
  return "$rc"
}

check_one_in() {
  local box="$1" _path="$2" _slug="$3" _pr="$4"
  local body msgs body_hits msg_hits head_sha state verdict rollup_head msgs_rc
  local attempt gh_rc read_rc said began repo_neutral pr_json pr_rc checks_json endpoint

  gh_rest "$box/pr.json" "$box/err" "repos/${_slug}/pulls/${_pr}"; pr_rc=$?
  pr_json=$(cat "$box/pr.json" 2>/dev/null)
  body=$(printf '%s' "$pr_json" \
         | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('title') or ''); print(d.get('body') or '')" 2>/dev/null)

  # AN EMPTY BODY IS A FAILED READ, NOT A CLEAN ONE. gh can fail for a wrong slug, an
  # expired token, a rate limit or a deleted pull request, and every one of those produces
  # the same empty string that a compliant pull request with no text would. The check below
  # cannot tell them apart, so refuse here instead of passing trivially.
  if [ "$pr_rc" -ne 0 ] || [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]; then
    said=$(head -n 1 "$box/err" 2>/dev/null)
    echo "lane-handoff.sh: read an EMPTY body for $_slug#$_pr - refusing to report compliance." >&2
    echo "                 gh may have failed, the token may be expired, or the pull request" >&2
    echo "                 may not exist. An empty read is not a clean read." >&2
    [ -n "$said" ] && echo "                 gh said: ${said}" >&2
    return 7
  fi
  gh_rest "$box/commits.json" "$box/err" -X GET "repos/${_slug}/pulls/${_pr}/commits" --paginate --slurp -F per_page=100; gh_rc=$?
  msgs=$(python3 -c "
import json,sys
pages=json.load(open(sys.argv[1]))
cs=[c for p in pages for c in (p if isinstance(p,list) else [])]
if not cs: raise SystemExit(1)
for c in cs:
    cm=(c or {}).get('commit') or {}
    print(cm.get('message') or '')
    for who in (cm.get('author'), cm.get('committer')):
        if who: print('%s <%s>' % (who.get('name') or '', who.get('email') or ''))
" "$box/commits.json" 2>/dev/null); msgs_rc=$?
  if [ "$gh_rc" != 0 ] || [ "$msgs_rc" != 0 ] || [ -z "$(printf '%s' "$msgs" | tr -d '[:space:]')" ]; then
    said=$(head -n 1 "$box/err" 2>/dev/null)
    echo "lane-handoff.sh: could not read the commits of ${_slug}#${_pr} from GitHub, so its" >&2
    echo "                 commit messages and trailers cannot be graded. A compliance pass over" >&2
    echo "                 the pull request body alone is not a compliance pass, so nothing was" >&2
    echo "                 labelled. gh may have failed, the token may be expired, or the pull" >&2
    echo "                 request may not exist. An empty read is not a clean read." >&2
    [ -n "$said" ] && echo "                 gh said: ${said}" >&2
    return 7
  fi

  repo_neutral=$(neutral_for "$_path")
  body_hits=$(printf '%s\n' "$body" \
    | sed "$repo_neutral" \
    | grep -inE "$authorship|$leakage" \
    | head -20)
  msg_hits=$(printf '%s\n' "$msgs" \
    | sed "$repo_neutral" \
    | grep -inE "$authorship|$leakage" \
    | head -20)

  if [ -n "$body_hits" ] || [ -n "$msg_hits" ]; then
    echo "non-compliant: ${_slug}#${_pr} was NOT labelled."
    if [ -n "$body_hits" ]; then
      echo "In the title or body, which a run fixes in place. Offending lines:"
      printf '%s\n' "$body_hits"
    fi
    if [ -n "$msg_hits" ]; then
      echo "In a commit message or trailer, which a run CANNOT fix. Offending lines:"
      printf '%s\n' "$msg_hits"
    fi
    echo ""
    if [ -n "$msg_hits" ]; then
      echo "A COMMIT-MESSAGE HIT MEANS THIS PULL REQUEST NOW NEEDS A PERSON. Rewording one"
      echo "rewrites history and the force-push it needs is refused to a lane, so there is no"
      echo "route from here to a label: report it, say which commit, and stop. Do not label it by"
      echo "hand, and do not re-run this expecting a different answer. The moment it was fixable"
      echo "was before the push, where an amend costs nothing:"
      echo "  lane-handoff.sh --repo-path <abs> --pre-push"
      echo "Run that before every push and this half stops happening."
      echo ""
    fi
    if [ -n "$body_hits" ]; then
      echo "Fix the PR body, then run this again."
    fi
    echo "THIS REFUSAL IS TERMINAL:"
    echo "your judgement decides HOW TO REWORD a hit, never whether to proceed past it. Nothing"
    echo "here is labelled by hand instead, and a hit you believe is a false positive is still a"
    echo "rewrite - the only way to a label is a re-run of this script that exits 0."
    echo "A vendor or product name that is the SUBJECT of the change is fine - the test is whether"
    echo "the text claims who or what wrote the code. THE HANDOFF LABEL TOKEN HAS NO SUCH"
    echo "EXEMPTION AND NO COMPLIANT SPELLING: this grep reads the literal token, so backticks,"
    echo "a code fence and a quotation from a file in the repository all still hit. That applies"
    echo "whether the sentence reports THIS pull request's own state or is documentation about the"
    echo "handoff mechanics - both are reworded the same way, by naming the label in words instead"
    echo "of writing the token: 'the handoff label' carries the meaning and passes."
    echo "Judge each hit to choose the rewording; do not blanket-rewrite."
    return 2
  fi

  # 2. Is it actually green? An empty rollup is not a pass, and a rollup describing an older head
  #    says nothing about what is on the branch now.
  gh_rest "$box/ref.json" "$box/err" "repos/${_slug}/git/ref/heads/${BRANCH}"
  head_sha=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
if not isinstance(d,dict): raise SystemExit(1)
print((d.get('object') or {}).get('sha') or '')
" "$box/ref.json" 2>/dev/null)
  HEAD_OF="$head_sha"
  if [ -z "$head_sha" ]; then
    said=$(head -n 1 "$box/err" 2>/dev/null)
    echo "lane-handoff.sh: could not read what sha ${BRANCH} is at in ${_slug} from GitHub, so" >&2
    echo "                 whether the rollup describes the current head is unknown. An empty" >&2
    echo "                 read is not a clean read. Nothing was labelled." >&2
    [ -n "$said" ] && echo "                 gh said: ${said}" >&2
    return 7
  fi
  rollup_head=$(printf '%s' "$pr_json" \
    | python3 -c "import json,sys; print(((json.load(sys.stdin).get('head') or {}).get('sha') or ''))" 2>/dev/null)
  if [ -z "$rollup_head" ]; then
    began=$(printf '%s' "$pr_json" | head -c 120 | tr '\n\t' '  ')
    echo "unreadable: the pull request ${_slug}#${_pr} names no head sha - nothing is known about its checks"
    echo "            attempted: gh api repos/${_slug}/pulls/${_pr}"
    echo "            gh returned ${#pr_json} bytes beginning: ${began}"
    echo "            Nothing was labelled and no check is known to have failed. Retry the read."
    return 9
  fi
  for endpoint in check-runs status; do
    attempt="gh api repos/${_slug}/commits/${rollup_head}/${endpoint}"
    gh_rest "$box/${endpoint}.json" "$box/err" -X GET "repos/${_slug}/commits/${rollup_head}/${endpoint}" --paginate --slurp -F per_page=100
    gh_rc=$?
    if [ "$gh_rc" -ne 0 ] || [ ! -s "$box/${endpoint}.json" ]; then
      said=$(head -n 1 "$box/err" 2>/dev/null)
      echo "unreadable: could not read the status rollup for ${_slug}#${_pr} - nothing is known about its checks"
      echo "            attempted: ${attempt}"
      echo "            gh exited ${gh_rc} and said: ${said:-nothing on stderr}"
      echo "            Nothing was labelled and no check is known to have failed. Retry the read."
      return 9
    fi
  done

  state=$(python3 -c "
import json,sys
def pages(path):
    p=json.load(open(path))
    return p if isinstance(p,list) else [p]
runs=[c for p in pages(sys.argv[1]) for c in (p.get('check_runs') or [])]
ctx=[c for p in pages(sys.argv[2]) for c in (p.get('statuses') or [])]
pr=json.load(open(sys.argv[3]))
m=pr.get('mergeable'); s=str(pr.get('mergeable_state') or '').lower()
c='CONFLICTED' if m is False or s == 'dirty' else ''
if not runs and not ctx: print('EMPTY|'+c); raise SystemExit
bad=[c2.get('name') or 'unnamed' for c2 in runs
     if str(c2.get('conclusion') or '').lower() not in ('success','neutral','skipped')]
bad+=[c2.get('context') or 'unnamed' for c2 in ctx if str(c2.get('state') or '').lower() != 'success']
print(('BAD:'+','.join(bad) if bad else 'GREEN')+'|'+c)
" "$box/check-runs.json" "$box/status.json" "$box/pr.json" 2>"$box/err")
  read_rc=$?
  if [ "$read_rc" -ne 0 ] || [ -z "$state" ]; then
    said=$(tail -n 1 "$box/err" 2>/dev/null)
    checks_json=$(cat "$box/check-runs.json" 2>/dev/null)
    began=$(printf '%s' "$checks_json" | head -c 120 | tr '\n\t' '  ')
    echo "unreadable: the status rollup for ${_slug}#${_pr} did not parse - nothing is known about its checks"
    echo "            attempted: gh api repos/${_slug}/commits/${rollup_head}/check-runs and /status"
    echo "            the reader exited ${read_rc} and said: ${said:-nothing on stderr}"
    echo "            gh returned ${#checks_json} bytes beginning: ${began}"
    echo "            Nothing was labelled and no check is known to have failed. Retry the read."
    return 9
  fi

  verdict=${state%%|*}; conflict=${state#*|}

  stale=0
  if [ -n "$rollup_head" ] && [ "$rollup_head" != "$head_sha" ]; then stale=1; fi

  if { [ "$verdict" != GREEN ] || [ "$stale" = 1 ]; } && [ "$conflict" = CONFLICTED ]; then
    echo "conflicted: ${_slug}#${_pr} conflicts with master, so GitHub schedules NO checks for it"
    echo "            at all - this rollup will not fill in and waiting on it costs the whole lane."
    echo "            Merge master into ${BRANCH}, resolve, push, and wait on the new head."
    return 3
  fi

  case "$verdict" in
    GREEN) ;;
    EMPTY) echo "not-green: rollup is empty on ${_slug}#${_pr} - no check has registered, which is not a pass"; return 4 ;;
    *)     echo "not-green: ${verdict} on ${_slug}#${_pr}"; return 4 ;;
  esac
  if [ "$stale" = 1 ]; then
    echo "not-green: rollup describes ${rollup_head} but the head of ${_slug}#${_pr} is ${head_sha}"
    return 4
  fi
  return 0
}

# A path MAY BE OMITTED and then it is the repository's key, which is what config.sh's own
# --check validator blesses. Defaulting it to the empty string instead resolved every such
# repository to the workspace ROOT, and the worktree sweep below would then look for the
# branch's checkout in the wrong repository.
cfg_err_file=$(mktemp "${TMPDIR:-/tmp}/lane-handoff-cfg.XXXXXX")
CONFIGURED=$(bash "$SKILL_DIR/config.sh" repos 2>"$cfg_err_file" | python3 -c "
import json,sys
try: repos=json.load(sys.stdin)
except Exception: raise SystemExit(1)
if not isinstance(repos,dict): raise SystemExit(1)
for name in sorted(repos):
    r=repos[name] or {}
    print('%s|%s|%s' % (name, r.get('path') or name, r.get('slug') or ''))
" 2>/dev/null)
CFG_CODE=$?
CFG_ERR=$(cat "$cfg_err_file")
rm -f "$cfg_err_file"

TRIPLES="${REPO_PATH}${TAB}${SLUG}${TAB}${PR}"
SEEN="${SLUG}#${PR}"
SWEPT_LIST=""
SWEPT_PATHS=""

# AN UNENUMERABLE CONFIG IS A REFUSAL, NOT A WARNING. This used to print "check the other
# repositories by hand" and carry on labelling the one pull request it was told about, which is
# exactly the defect this script was changed to remove - and the remedy it printed is the one
# the issue names as the trap, because a supervisor reading two repositories per ticket by hand
# is the cost that made this worth fixing. It was inconsistent as well: ONE repository that
# could not be listed refused with nothing labelled while ALL of them unreadable - strictly less
# information - passed at exit 0. config.sh finds the config by walking up from the working
# directory, and this script cd's into --repo-path first, so a handoff run from a lane worktree
# outside the workspace reaches this path rather than a theoretical one.
if [ "$CFG_CODE" != 0 ]; then
  echo "lane-handoff.sh: the workspace config could not be read, so the pull requests on" >&2
  echo "                 ${BRANCH} cannot be enumerated and a second one cannot be ruled out." >&2
  echo "                 Nothing was labelled. Re-run from a checkout inside the workspace, or" >&2
  echo "                 point PITWALL_CONFIG at the config file." >&2
  [ -n "$CFG_ERR" ] && printf '                 %s\n' "$CFG_ERR" >&2
  exit 7
fi
if [ -z "$CONFIGURED" ]; then
  echo "lane-handoff.sh: the workspace config names no repositories, so the pull requests on" >&2
  echo "                 ${BRANCH} cannot be enumerated and a second one cannot be ruled out." >&2
  echo "                 Nothing was labelled. Add the repositories to the config - including" >&2
  echo "                 ${SLUG} - then re-run." >&2
  exit 7
fi

while IFS="|" read -r rname rpath rslug; do
  [ -n "$rname" ] || continue
  case "$rpath" in
    /*) rdir="$rpath" ;;
    *) rdir="$CFG_ROOT/$rpath" ;;
  esac
  if [ -z "$rslug" ]; then
    rslug=$(git -C "$rdir" remote get-url origin 2>/dev/null \
            | sed -e 's#\.git$##' -e 's#^git@github\.com:##' -e 's#^https://github\.com/##')
    # owner/name AND NOTHING ELSE. An origin that is a local path - a bare repository beside the
    # checkout, a mirror - survives the rewrites above and still holds a slash, so a bare */*
    # test would hand a directory to gh as a repository and read its answer as "no pull requests".
    case "$rslug" in
      /*|*/*/*) rslug="" ;;
      */*) ;;
      *) rslug="" ;;
    esac
  fi
  if [ -z "$rslug" ]; then
    echo "lane-handoff.sh: ${rname} has no slug in the workspace config and none could be" >&2
    echo "                 derived from ${rdir}, so a pull request of its own on ${BRANCH}" >&2
    echo "                 cannot be ruled out. Nothing was labelled. Add slug: \"owner/name\"" >&2
    echo "                 to it, then re-run." >&2
    exit 7
  fi
  survey_out=$(mktemp "${TMPDIR:-/tmp}/lane-handoff-survey.XXXXXX")
  survey_err=$(mktemp "${TMPDIR:-/tmp}/lane-handoff-survey.XXXXXX")
  gh_rest "$survey_out" "$survey_err" -X GET "repos/${rslug}/pulls" -f head="${rslug%%/*}:${BRANCH}" -f state=open -F per_page=100
  survey_rc=$?
  found=$(python3 -c "
import json,sys
try: prs=json.load(open(sys.argv[1]))
except Exception: raise SystemExit(1)
if not isinstance(prs,list): raise SystemExit(1)
for p in prs:
    n=(p or {}).get('number')
    if n: print(n)
" "$survey_out" 2>/dev/null)
  found_rc=$?
  if [ "$survey_rc" != 0 ] || [ "$found_rc" != 0 ]; then
    said=$(head -n 1 "$survey_err" 2>/dev/null)
    rm -f "$survey_out" "$survey_err"
    echo "lane-handoff.sh: could not list the open pull requests of ${rslug} on ${BRANCH}." >&2
    echo "                 Nothing was labelled. An empty read is not a clean read, and a" >&2
    echo "                 second repository's pull request is exactly what hides in one." >&2
    [ -n "$said" ] && echo "                 gh said: ${said}" >&2
    exit 7
  fi
  rm -f "$survey_out" "$survey_err"
  for num in $found; do
    case " $SEEN " in *" ${rslug}#${num} "*) continue ;; esac
    if [ "$rslug" = "$SLUG" ]; then rp="$REPO_PATH"; else rp="$rdir"; fi
    SEEN="$SEEN ${rslug}#${num}"
    SWEPT_LIST="$SWEPT_LIST ${rslug}#${num}"
    SWEPT_PATHS="${SWEPT_PATHS}${rp}
"
    TRIPLES="${TRIPLES}
${rp}${TAB}${rslug}${TAB}${num}"
  done
done <<EOF
$CONFIGURED
EOF

FAILED=0
FAIL_CODE=0
HEAD_SHA=""
HEAD_OF=""
while IFS="$TAB" read -r cpath cslug cpr; do
  [ -n "$cpr" ] || continue
  if check_one "$cpath" "$cslug" "$cpr"; then
    :
  else
    rc=$?
    FAILED=$((FAILED + 1))
    if [ "$FAIL_CODE" = 0 ]; then FAIL_CODE=$rc; fi
  fi
  if [ "$cslug" = "$SLUG" ] && [ "$cpr" = "$PR" ]; then HEAD_SHA="$HEAD_OF"; fi
done <<EOF
$TRIPLES
EOF

if [ "$FAILED" != 0 ]; then
  echo ""
  echo "NOTHING was labelled. ${FAILED} of the pull requests on ${BRANCH} is not ready, and a"
  echo "ticket whose second repository stays unlabelled closes on the half that landed."
  echo "Pull requests on ${BRANCH}: ${SEEN}"
  exit "$FAIL_CODE"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "compliant and green: ${SLUG}#${PR} at ${HEAD_SHA} - nothing was changed (--check-only)"
  [ -n "$SWEPT_LIST" ] && echo "also compliant and green on ${BRANCH}:${SWEPT_LIST}"
  exit 0
fi

# 3. Prove every repository in the set can carry the label before the first one is labelled.
preflight_err_file=$(mktemp "${TMPDIR:-/tmp}/lane-handoff-label.XXXXXX")
preflight_out_file=$(mktemp "${TMPDIR:-/tmp}/lane-handoff-label.XXXXXX")
for pslug in $(printf '%s\n' "$TRIPLES" | cut -f2 | sort -u); do
  [ -n "$pslug" ] || continue
  : > "$preflight_err_file"
  gh_rest "$preflight_out_file" "$preflight_err_file" -X GET "repos/${pslug}/labels" --paginate --slurp -F per_page=100
  label_rc=$?
  label_json=$(cat "$preflight_out_file" 2>/dev/null)
  if [ "$label_rc" -ne 0 ]; then
    echo "lane-handoff.sh: could not read the labels of ${pslug}, so whether it can carry" >&2
    echo "                 ${LABEL} is unknown. Nothing was labelled." >&2
    perr=$(cat "$preflight_err_file"); [ -n "$perr" ] && printf '                 gh said: %s\n' "$perr" >&2
    rm -f "$preflight_err_file" "$preflight_out_file"
    exit 7
  fi
  case "$label_json" in
    *[![:space:]]*)
      have=$(printf '%s' "$label_json" | python3 -c "
import json,sys
try: pages=json.load(sys.stdin)
except Exception: raise SystemExit(1)
labels=[l for p in pages for l in (p if isinstance(p,list) else [p])]
print('YES' if any((l or {}).get('name') == sys.argv[1] for l in labels) else 'NO')
" "$LABEL" 2>/dev/null) ;;
    *) have=NO ;;
  esac
  if [ "$have" != "YES" ] && [ "$have" != "NO" ]; then
    echo "lane-handoff.sh: ${pslug} answered its label list in a shape this cannot read, so" >&2
    echo "                 whether it can carry ${LABEL} is unknown. Nothing was labelled." >&2
    printf '                 it said: %s\n' "$label_json" >&2
    rm -f "$preflight_err_file" "$preflight_out_file"
    exit 7
  fi
  if [ "$have" = "NO" ]; then
    if ! gh label create "$LABEL" --repo "$pslug" \
         --description "Reviewed and green: ready for the serial lander" \
         --color 0E8A16 >/dev/null 2>"$preflight_err_file"; then
      perr=$(cat "$preflight_err_file")
      case "$perr" in
        *"already exists"*) ;;
        *)
          echo "lane-handoff.sh: ${pslug} has no ${LABEL} label and one could not be created," >&2
          echo "                 so labelling it would fail part-way through the branch." >&2
          echo "                 Nothing was labelled." >&2
          [ -n "$perr" ] && printf '                 gh said: %s\n' "$perr" >&2
          rm -f "$preflight_err_file" "$preflight_out_file"
          exit 7 ;;
      esac
    fi
    echo "created the ${LABEL} label in ${pslug} - it had none"
  fi
done

# 4. Label, then read it back. Setting it is not the same as it being set.
labels=""
LABELLED=""
while IFS="$TAB" read -r cpath cslug cpr; do
  [ -n "$cpr" ] || continue
  # KEEP gh's REASON. This discarded stderr, so a 403, a rate limit or a missing label all read
  # as the same bare "the label did not stick" with nothing to act on.
  edit_err=""
  gh_rest "$preflight_out_file" "$preflight_err_file" -X POST "repos/${cslug}/issues/${cpr}/labels" -f "labels[]=${LABEL}" \
    || edit_err=$(cat "$preflight_err_file")
  gh_rest "$preflight_out_file" "$preflight_err_file" -X GET "repos/${cslug}/issues/${cpr}/labels" --paginate --slurp -F per_page=100
  back=$(python3 -c "
import json,sys
pages=json.load(open(sys.argv[1]))
print(','.join((l or {}).get('name') or '' for p in pages for l in (p if isinstance(p,list) else [p])))
" "$preflight_out_file" 2>/dev/null)
  case ",$back," in
    *,"$LABEL",*) LABELLED="$LABELLED ${cslug}#${cpr}" ;;
    *)
      echo "half-labelled: the label did not stick on ${cslug}#${cpr} - read back: ${back:-none}"
      [ -n "$edit_err" ] && echo "  gh said: ${edit_err}"
      echo "  CARRYING ${LABEL} now:${LABELLED:- nothing}"
      echo "  NOT carrying it: ${cslug}#${cpr}, and anything after it in: ${SEEN}"
      echo "  The lander reads only the label, so a pull request left out of that first list is"
      echo "  invisible to it and its half of the ticket closes on the half that landed."
      echo "  Adding a label is idempotent and nothing has been cleaned up or recorded yet, so fix"
      echo "  what gh reported and RE-RUN this command rather than labelling the rest by hand."
      rm -f "$preflight_err_file" "$preflight_out_file"
      exit 8 ;;
  esac
  if [ "$cslug" = "$SLUG" ] && [ "$cpr" = "$PR" ]; then labels="$back"; fi
done <<EOF
$TRIPLES
EOF
rm -f "$preflight_err_file" "$preflight_out_file"

# 5. Remove the lane's worktree so the lander's --delete-branch does not trip on a checked-out
#    branch. Only this lane's own - never a sweep.
#
# IF --worktree WAS NOT PASSED, FIND IT. Three lanes on 2026-08-28 reported "no worktree in use"
# while one sat checked out on their branch: app-w23d.4, app-ks1y and app-f5ma all left theirs
# behind, and a supervisor removed them by hand. The lane is not lying so much as not knowing -
# it did not create the worktree itself in those runs. The branch is the reliable key, so ask
# git rather than the caller.
if [ -z "$WT" ]; then
  WT=$(git worktree list --porcelain 2>/dev/null | python3 -c "
import sys
want='refs/heads/'+sys.argv[1]
path=None
for line in sys.stdin:
    line=line.rstrip()
    if line.startswith('worktree '): path=line[9:]
    elif line.startswith('branch ') and line[7:]==want and path:
        print(path); break
" "$BRANCH" 2>/dev/null)
  [ -n "$WT" ] && echo "found worktree for ${BRANCH}: ${WT} (not passed in, looked up)"
fi

if [ -n "$WT" ]; then
  # NEVER REMOVE THE MAIN CHECKOUT, WHATEVER WAS PASSED IN. On 2026-08-29 a lane handed
  # --worktree pointing at the repository itself, and this ran 'git worktree remove' against the
  # checkout a person works in. Only git's own refusal - a main working tree cannot be removed
  # that way - stopped it, and --force was on the command line. That is a safety net belonging to
  # git, not to this script, and it should not be the last line of defence.
  #
  # The real worktrees all sit under /tmp; the main checkout never does. Compare resolved paths
  # rather than strings, so a symlinked or /private-prefixed form cannot slip past.
  wt_real=$(cd "$WT" 2>/dev/null && pwd -P)
  repo_real=$(cd "$REPO_PATH" 2>/dev/null && pwd -P)
  main_real=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
  main_real=$(cd "$main_real" 2>/dev/null && pwd -P)

  if [ -z "$wt_real" ]; then
    echo "worktree ${WT} does not exist - nothing to remove"
  elif [ "$wt_real" = "$repo_real" ] || [ "$wt_real" = "$main_real" ]; then
    echo "handed off WITH A WARNING: REFUSED to remove ${WT} - that is the main checkout, not a"
    echo "  lane worktree. Nothing was touched. Whatever passed --worktree passed the wrong path;"
    echo "  a lane worktree lives under /tmp and is named for the issue."
  else
    git worktree remove "$wt_real" --force >/dev/null 2>/dev/null
    git worktree prune >/dev/null 2>/dev/null
    if git worktree list 2>/dev/null | grep -qF "$wt_real"; then
      echo "handed off WITH A WARNING: ${WT} could not be removed and is still checked out"
    fi
  fi
fi

while IFS= read -r srepo; do
  [ -n "$srepo" ] || continue
  swt=$(git -C "$srepo" worktree list --porcelain 2>/dev/null | python3 -c "
import sys
want='refs/heads/'+sys.argv[1]
path=None
for line in sys.stdin:
    line=line.rstrip()
    if line.startswith('worktree '): path=line[9:]
    elif line.startswith('branch ') and line[7:]==want and path:
        print(path); break
" "$BRANCH" 2>/dev/null)
  [ -n "$swt" ] || continue
  swt_real=$(cd "$swt" 2>/dev/null && pwd -P)
  smain=$(git -C "$srepo" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
  smain=$(cd "$smain" 2>/dev/null && pwd -P)
  srepo_real=$(cd "$srepo" 2>/dev/null && pwd -P)
  if [ -z "$swt_real" ]; then
    continue
  elif [ "$swt_real" = "$srepo_real" ] || [ "$swt_real" = "$smain" ]; then
    echo "handed off WITH A WARNING: REFUSED to remove ${swt} - that is the main checkout of"
    echo "  ${srepo}, not a lane worktree. Nothing was touched."
  else
    git -C "$srepo" worktree remove "$swt_real" --force >/dev/null 2>/dev/null
    git -C "$srepo" worktree prune >/dev/null 2>/dev/null
    if git -C "$srepo" worktree list 2>/dev/null | grep -qF "$swt_real"; then
      echo "handed off WITH A WARNING: ${swt} could not be removed and is still checked out"
    fi
  fi
done <<EOF
$SWEPT_PATHS
EOF

# 6. Record it. --append-notes, never --notes: the field has no history and an overwrite is
#    simply gone. Text comes from a file so nothing expands.
NOTE_VERDICT=""
if [ -n "$ISSUE" ] && [ -n "$NOTE_FILE" ]; then
  # RUN bd FROM THE WORKSPACE ROOT, NOT FROM INSIDE A REPOSITORY. This script cd's into the repo
  # at the top, and bd was inheriting that. The project's own notes say to run bd from the root;
  # setting BEADS_DIR is not the same thing, because bd also resolves against the working
  # directory. The append silently did nothing twice - 2026-08-28 and again on app-osl6 on
  # 2026-08-29 - and both times the verification below is the only reason anybody noticed.
  #
  # And KEEP THE ERROR. The old form sent stderr to /dev/null, so when bd refused there was
  # nothing to read and the failure looked like success with an empty result. That is what made
  # this take two sightings to place.
  # THROUGH bd-note.sh, NOT bd DIRECTLY. The append is a read-modify-write on one text field with
  # nothing serialising it, so two overlapping writers both read the old notes, both append, and
  # the second wins - silently, exit 0, with the usual "Updated issue" line. Measured 2026-09-06
  # (app-f3cq): eight concurrent appends to one issue, all exit 0, TWO LOST. Up to five lanes plus
  # trains plus the supervisor write notes, so overlap is the normal case, not the rare one.
  # bd-note.sh takes a lock, then verifies and retries. Through it the same eight-way race loses
  # none. The read-back below stays regardless - it is what caught this in the first place.
  bd_out_file=$(mktemp "${TMPDIR:-/tmp}/lane-handoff-note.XXXXXX")
  bd_err=$( (cd "$ROOT_DIR" && BEADS_DIR="${BEADS_DIR:-$ROOT_DIR/.beads}" \
    PITWALL_SESSION="${PITWALL_SESSION:-lane-${BRANCH}}" \
    bash "$SKILL_DIR/bd-note.sh" "$ISSUE" --note-file "$NOTE_FILE" >"$bd_out_file") 2>&1 )
  bd_code=$?
  bd_out=$(cat "$bd_out_file" 2>/dev/null)
  rm -f "$bd_out_file"
  if [ "$bd_code" != "0" ]; then
    echo "bd update exited ${bd_code} for ${ISSUE}: ${bd_err:-no message}"
  fi
  note_transformed=""
  case "$bd_out" in
    *"stored text differs from what was sent"*) note_transformed=yes ;;
  esac
  # PROVE IT LANDED. On 2026-08-28 this step reported success while the note was absent - the
  # lane read the issue back itself, found nothing, and appended by hand. A length nobody
  # compares against anything is not evidence. Check the text is actually in the field.
  got=$(cd "$ROOT_DIR" && BEADS_DIR="${BEADS_DIR:-$ROOT_DIR/.beads}" bd show "$ISSUE" --json 2>/dev/null \
    | python3 -c "
import json,sys,io,re
d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d
notes=d.get('notes') or ''
want=io.open(sys.argv[1],encoding='utf-8',errors='replace').read()
flat=lambda t: re.sub(r'[^A-Za-z0-9]', '', t)
probe=flat(want)
ok = bool(probe) and probe in flat(notes)
print('%s|%d|%s' % (d.get('status'), len(notes), 'APPENDED' if ok else 'MISSING'))" "$NOTE_FILE" 2>/dev/null)
  case "$got" in
    *APPENDED*) echo "tracker: ${ISSUE} ${got}" ;;
    *MISSING*)
      if [ -n "$note_transformed" ]; then
        diverged_at=$(printf '%s\n' "$bd_err" | grep -m1 'diverges at character')
        echo "handed off WITH A WARNING: ${ISSUE} holds the note in transformed form - bd altered"
        echo "  the text on the way in, so the whole of it is not in the field (${got})."
        echo "  ${diverged_at:-bd-note.sh reported the divergence without naming an offset}"
        echo "  It was recorded once and warned about once. Do NOT append it again."
      else
        NOTE_VERDICT=MISSING
      fi
      ;;
    *)          NOTE_VERDICT=UNREADABLE ;;
  esac
fi

# 7. Give the lane back last, so a crash before this leaves the slot held rather than handing it
#    to a dispatch that lands on top of a run still finishing.
if [ -n "$LOCK" ]; then
  lane="${LOCK%/}"
  rm -f "${lane%.lock}.owner"
  rmdir "$lane" 2>/dev/null
fi

if [ -n "$NOTE_VERDICT" ]; then
  echo "note-unconfirmed: ${SLUG}#${PR} at ${HEAD_SHA} IS labelled ${LABEL}, the worktree is gone"
  echo "  and the lane lock is dropped. Everything but the tracker note is done, so do NOT re-run"
  echo "  this script."
  if [ "$NOTE_VERDICT" = "MISSING" ]; then
    echo "  ${ISSUE} was read back and the note is NOT in it (${got}). Append it and read it back:"
    echo "    bash ${SKILL_DIR}/bd-note.sh ${ISSUE} --note-file ${NOTE_FILE}"
  else
    echo "  ${ISSUE} could not be read back at all, which is NOT evidence the note was lost."
    echo "  Read the field first - bd show ${ISSUE} --json - and append only if it is absent."
  fi
  echo "labels now: ${labels}"
  exit 5
fi

echo "handed off: ${SLUG}#${PR} at ${HEAD_SHA}, labelled ${LABEL}"
[ -n "$SWEPT_LIST" ] && echo "also labelled ${LABEL} on ${BRANCH}:${SWEPT_LIST}"
echo "labels now: ${labels}"
exit 0
