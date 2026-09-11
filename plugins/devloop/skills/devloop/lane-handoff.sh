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
#                   [--label lane-verified] [--check-only]
#
#   Other open pull requests on --branch, across the repositories the workspace config names, are
#   derived and handled in the same invocation.
#
# Exit codes:
#   0  handed off    every pull request on the branch compliant and labelled, cleaned up, note
#                    recorded and read back
#   2  non-compliant NOTHING was labelled anywhere. The offending lines are printed against the
#                    pull request they came from. Fix, then re-run.
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
#                    one of their texts could not be read. Nothing was labelled anywhere.
#                    Fix what it names, then re-run.
#   8  half-labelled labelling began and could not be finished. It prints which pull requests
#                    carry the label and which do not. Adding a label is idempotent and this
#                    exits before the worktree removal and the tracker note, so re-run it once
#                    the cause is gone rather than labelling the rest by hand.

set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL=lane-verified
REPO_PATH=""; SLUG=""; PR=""; BRANCH=""; ISSUE=""; NOTE_FILE=""; WT=""; LOCK=""; CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) REPO_PATH="${2:-}"; shift 2 ;;
    --slug)      SLUG="${2:-}";      shift 2 ;;
    --pr)        PR="${2:-}";        shift 2 ;;
    --branch)    BRANCH="${2:-}";    shift 2 ;;
    --issue)     ISSUE="${2:-}";     shift 2 ;;
    --note-file) NOTE_FILE="${2:-}"; shift 2 ;;
    --worktree)  WT="${2:-}";        shift 2 ;;
    --lane-lock) LOCK="${2:-}";      shift 2 ;;
    --label)     LABEL="${2:-}";     shift 2 ;;
    --check-only) CHECK_ONLY=1;      shift 1 ;;
    *) echo "unknown argument: $1" >&2; exit 6 ;;
  esac
done
for req in REPO_PATH SLUG PR BRANCH; do
  eval "v=\$$req"; [ -n "$v" ] || { echo "missing --$(echo "$req" | tr 'A-Z_' 'a-z-')" >&2; exit 6; }
done
case "$PR" in ''|*[!0-9]*) echo "--pr must be a number, got: $PR" >&2; exit 6 ;; esac

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
neutral='s#[A-Za-z/._-]*CLAUDE\.md#REPO-DOC#g; s#[A-Za-z/._-]*AGENTS\.md#REPO-DOC#g'

# 1. COMPLIANCE, read back from where the text is actually stored rather than from what anybody
#    meant to write. GitHub and git both add and rewrite text.
check_one() {
  local _path="$1" _slug="$2" _pr="$3"
  local body msgs trailers hits head_sha state verdict rollup_head

  body=$(gh pr view "$_pr" --repo "$_slug" --json title,body 2>/dev/null \
         | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('title','')); print(d.get('body',''))" 2>/dev/null)

  # AN EMPTY BODY IS A FAILED READ, NOT A CLEAN ONE. gh can fail for a wrong slug, an
  # expired token, a rate limit or a deleted pull request, and every one of those produces
  # the same empty string that a compliant pull request with no text would. The check below
  # cannot tell them apart, so refuse here instead of passing trivially.
  if [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]; then
    echo "lane-handoff.sh: read an EMPTY body for $_slug#$_pr - refusing to report compliance." >&2
    echo "                 gh may have failed, the token may be expired, or the pull request" >&2
    echo "                 may not exist. An empty read is not a clean read." >&2
    return 7
  fi
  msgs=$(git -C "$_path" log "origin/master..origin/${BRANCH}" --format=%B 2>/dev/null)
  trailers=$(git -C "$_path" log "origin/master..origin/${BRANCH}" --format='%an <%ae>%n%(trailers)' 2>/dev/null)

  hits=$(printf '%s\n%s\n%s\n' "$body" "$msgs" "$trailers" \
    | sed "$neutral" \
    | grep -inE "$authorship|$leakage" \
    | head -20)

  if [ -n "$hits" ]; then
    echo "non-compliant: ${_slug}#${_pr} was NOT labelled. Offending lines:"
    printf '%s\n' "$hits"
    echo ""
    echo "Fix the PR body or the commit message, then run this again. Note that a vendor or"
    echo "product name that is the SUBJECT of the change is fine - the test is whether the text"
    echo "claims who or what wrote the code. Judge each hit; do not blanket-rewrite."
    return 2
  fi

  # 2. Is it actually green? An empty rollup is not a pass, and a rollup describing an older head
  #    says nothing about what is on the branch now.
  head_sha=$(git -C "$_path" rev-parse "origin/${BRANCH}" 2>/dev/null)
  HEAD_OF="$head_sha"
  state=$(gh pr view "$_pr" --repo "$_slug" --json statusCheckRollup,headRefOid,mergeable,mergeStateStatus 2>/dev/null \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
r=d.get('statusCheckRollup') or []
m=str(d.get('mergeable') or '').upper()
s=str(d.get('mergeStateStatus') or '').upper()
c='CONFLICTED' if m == 'CONFLICTING' or s == 'DIRTY' else ''
if not r: print('EMPTY||'+c); raise SystemExit
bad=[c2.get('name') for c2 in r if c2.get('conclusion') not in ('SUCCESS','NEUTRAL','SKIPPED')]
print(('BAD:'+','.join(bad) if bad else 'GREEN')+'|'+(d.get('headRefOid') or '')+'|'+c)
" 2>/dev/null)
  verdict=${state%%|*}; rest=${state#*|}; rollup_head=${rest%%|*}; conflict=${rest#*|}

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
# repository to the workspace ROOT: the -d test below passes, the origin/<branch> check then
# fails, and every handoff in that workspace hard-fails. Worse than the exit - had the root
# been a checkout carrying the branch, compliance would have been graded against the wrong
# repository's commit messages.
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
  found=$(gh pr list --repo "$rslug" --head "$BRANCH" --state open --json number 2>/dev/null \
    | python3 -c "
import json,sys
try: prs=json.load(sys.stdin)
except Exception: raise SystemExit(1)
for p in prs:
    n=p.get('number')
    if n: print(n)
" 2>/dev/null)
  if [ $? != 0 ]; then
    echo "lane-handoff.sh: could not list the open pull requests of ${rslug} on ${BRANCH}." >&2
    echo "                 Nothing was labelled. An empty read is not a clean read, and a" >&2
    echo "                 second repository's pull request is exactly what hides in one." >&2
    exit 7
  fi
  for num in $found; do
    case " $SEEN " in *" ${rslug}#${num} "*) continue ;; esac
    if [ "$rslug" = "$SLUG" ]; then rp="$REPO_PATH"; else rp="$rdir"; fi
    if [ ! -d "$rp" ]; then
      echo "lane-handoff.sh: ${rslug}#${num} is open on ${BRANCH} and ${rp} is not a checkout" >&2
      echo "                 here, so its commit messages cannot be read. Nothing was labelled." >&2
      exit 7
    fi
    git -C "$rp" fetch origin --quiet 2>/dev/null
    if ! git -C "$rp" rev-parse --verify --quiet "origin/${BRANCH}" >/dev/null; then
      echo "lane-handoff.sh: ${rslug}#${num} is open on ${BRANCH} but ${rp} has no" >&2
      echo "                 origin/${BRANCH}, so its commit messages cannot be read." >&2
      echo "                 Nothing was labelled." >&2
      exit 7
    fi
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
for pslug in $(printf '%s\n' "$TRIPLES" | cut -f2 | sort -u); do
  [ -n "$pslug" ] || continue
  : > "$preflight_err_file"
  label_json=$(gh label list --repo "$pslug" --search "$LABEL" --limit 100 --json name 2>"$preflight_err_file")
  label_rc=$?
  if [ "$label_rc" -ne 0 ]; then
    echo "lane-handoff.sh: could not read the labels of ${pslug}, so whether it can carry" >&2
    echo "                 ${LABEL} is unknown. Nothing was labelled." >&2
    perr=$(cat "$preflight_err_file"); [ -n "$perr" ] && printf '                 gh said: %s\n' "$perr" >&2
    rm -f "$preflight_err_file"
    exit 7
  fi
  case "$label_json" in
    *[![:space:]]*)
      have=$(printf '%s' "$label_json" | python3 -c "
import json,sys
try: labels=json.load(sys.stdin)
except Exception: raise SystemExit(1)
print('YES' if any((l or {}).get('name') == sys.argv[1] for l in labels) else 'NO')
" "$LABEL" 2>/dev/null) ;;
    *) have=NO ;;
  esac
  if [ "$have" != "YES" ] && [ "$have" != "NO" ]; then
    echo "lane-handoff.sh: ${pslug} answered its label list in a shape this cannot read, so" >&2
    echo "                 whether it can carry ${LABEL} is unknown. Nothing was labelled." >&2
    printf '                 it said: %s\n' "$label_json" >&2
    rm -f "$preflight_err_file"
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
          rm -f "$preflight_err_file"
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
  gh pr edit "$cpr" --repo "$cslug" --add-label "$LABEL" >/dev/null 2>"$preflight_err_file" \
    || edit_err=$(cat "$preflight_err_file")
  back=$(gh pr view "$cpr" --repo "$cslug" --json labels 2>/dev/null \
    | python3 -c "import json,sys; print(','.join(l['name'] for l in json.load(sys.stdin).get('labels') or []))" 2>/dev/null)
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
      rm -f "$preflight_err_file"
      exit 8 ;;
  esac
  if [ "$cslug" = "$SLUG" ] && [ "$cpr" = "$PR" ]; then labels="$back"; fi
done <<EOF
$TRIPLES
EOF
rm -f "$preflight_err_file"

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
  bd_err=$( (cd "$ROOT_DIR" && BEADS_DIR="${BEADS_DIR:-$ROOT_DIR/.beads}" \
    PITWALL_SESSION="${PITWALL_SESSION:-lane-${BRANCH}}" \
    bash "$SKILL_DIR/bd-note.sh" "$ISSUE" --note-file "$NOTE_FILE" >/dev/null) 2>&1 )
  bd_code=$?
  if [ "$bd_code" != "0" ]; then
    echo "bd update exited ${bd_code} for ${ISSUE}: ${bd_err:-no message}"
  fi
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
    *MISSING*)  NOTE_VERDICT=MISSING ;;
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
