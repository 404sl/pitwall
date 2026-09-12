#!/bin/bash
set -u

PLUGIN=plugins/devloop/.claude-plugin/plugin.json
MARKETPLACE=.claude-plugin/marketplace.json
LOG=plugins/devloop/skills/devloop/CHANGELOG.md
HEADING='## Plugin changelog'

WT=""; BASE="origin/master"; SLUG=""; ENTRY_FILE=""; PRS=""

say() { printf '%s\n' "$*"; }

help() {
  say "assign-plugin-version.sh - write the next devloop plugin version onto a branch that is"
  say "about to merge, because the lander is the only thing that knows what master holds now."
  say ""
  say "  --worktree <abs>      the worktree to write in. Required."
  say "  --base <ref>          the ref the number comes from. Default origin/master."
  say "  --slug <owner/name>   repository to read pull request bodies from."
  say "  --pr <n>              pull request whose body carries the changelog entry. Repeatable."
  say "  --entry-file <path>   changelog text to use instead of reading any body."
  say ""
  say "The entry text comes from the pull request body, under a '${HEADING}' heading, and"
  say "falls back to the pull request title when the body carries no such section. A version that"
  say "moves with nothing under its heading is refused rather than written, because the entry is"
  say "the whole point of moving the number."
  say ""
  say "Exit codes:"
  say "  0  assigned  all three files agree on a new version and a commit carries them."
  say "  2  skipped   the base ships no plugin manifest, or this branch changes nothing it ships."
  say "  5  refused   the base version cannot be read, no greater number could be written, no"
  say "               changelog text could be read for a pull request, or the branch changes one"
  say "               of the three files in more than its version."
  say "  6  usage     bad arguments, or the worktree is not a git worktree."
  say ""
  say "Running it twice on one branch is not an error: the second run finds the number already"
  say "written, adds nothing and still reports assigned."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --worktree)   WT="${2:-}";         shift 2 ;;
    --base)       BASE="${2:-}";       shift 2 ;;
    --slug)       SLUG="${2:-}";       shift 2 ;;
    --pr)         PRS="${PRS}${2:-} "; shift 2 ;;
    --entry-file) ENTRY_FILE="${2:-}"; shift 2 ;;
    -h|--help)    help; exit 0 ;;
    *) say "usage: unknown argument: $1"; exit 6 ;;
  esac
done

[ -n "$WT" ] || { say "usage: missing --worktree"; exit 6; }
[ -d "$WT" ] || { say "usage: no such directory: $WT"; exit 6; }
cd "$WT" || exit 6
git rev-parse --git-dir >/dev/null 2>/dev/null || { say "usage: not a git worktree: $WT"; exit 6; }

git cat-file -e "${BASE}:${PLUGIN}" 2>/dev/null || {
  say "skipped: ${BASE} ships no ${PLUGIN}, so there is no plugin version to assign"; exit 2; }

touched=$(git diff --name-only "${BASE}...HEAD" 2>/dev/null | grep -E '^(plugins/|\.claude-plugin/)' | head -3 | tr '\n' ' ')
if [ -z "$touched" ]; then
  say "skipped: this branch changes no file under plugins/ or .claude-plugin/"
  exit 2
fi

ident_name=$(git log -1 --format=%an "$BASE" 2>/dev/null)
ident_email=$(git log -1 --format=%ae "$BASE" 2>/dev/null)
git_with_identity() {
  if [ -n "$ident_name" ] && [ -n "$ident_email" ]; then
    git -c "user.name=$ident_name" -c "user.email=$ident_email" "$@"
  else
    git "$@"
  fi
}

commit_triple() {
  git add "$MARKETPLACE" "$PLUGIN" "$LOG" >/dev/null 2>/dev/null
  if git diff --cached --quiet 2>/dev/null; then
    return 2
  fi
  msgfile=$(mktemp "${TMPDIR:-/tmp}/plugin-version.XXXXXX")
  cat > "$msgfile"
  git_with_identity commit -q -F "$msgfile" >/dev/null 2>/dev/null
  code=$?
  rm -f "$msgfile"
  return $code
}

master_version=$(git show "${BASE}:${PLUGIN}" 2>/dev/null | python3 -c "
import json,re,sys
try:
    v = json.load(sys.stdin).get('version')
except Exception:
    raise SystemExit(0)
if isinstance(v, str) and re.fullmatch(r'\d+\.\d+\.\d+', v):
    print(v)
" 2>/dev/null)

if [ -z "$master_version" ]; then
  say "refused: ${BASE} declares no version in ${PLUGIN} that reads as three numbers, and a number nobody can read cannot be incremented"
  exit 5
fi

next_version=$(MASTER="$master_version" python3 -c "
import os
held = tuple(int(x) for x in os.environ['MASTER'].split('.'))
nxt = (held[0], held[1], held[2] + 1)
print('%d.%d.%d' % nxt if nxt > held else '')
" 2>/dev/null)

if [ -z "$next_version" ]; then
  say "refused: no version strictly greater than ${master_version} could be computed, and master's version must never go backwards"
  exit 5
fi

kind_of() {
  case "$1" in
    "$PLUGIN")      printf 'plugin' ;;
    "$MARKETPLACE") printf 'market' ;;
    *)              printf 'log' ;;
  esac
}

basefile=$(mktemp "${TMPDIR:-/tmp}/plugin-base.XXXXXX")

for path in "$MARKETPLACE" "$PLUGIN" "$LOG"; do
  git cat-file -e "${BASE}:${path}" 2>/dev/null || continue
  git show "${BASE}:${path}" > "$basefile" 2>/dev/null || {
    rm -f "$basefile"
    say "refused: ${path} could not be read from ${BASE}"; exit 5; }
  BASE_FILE="$basefile" BRANCH_FILE="$path" KIND="$(kind_of "$path")" python3 -c "
import json,os,re
kind = os.environ['KIND']

def text(path):
    with open(path) as f:
        return f.read().replace('\r\n', '\n')

def manifest(body, every):
    doc = json.loads(body)
    if every:
        for entry in doc.get('plugins') or []:
            if isinstance(entry, dict):
                entry.pop('version', None)
    else:
        doc.pop('version', None)
    return json.dumps(doc, sort_keys=True)

def without_top(body):
    lines = body.split('\n')
    start = None
    for i, line in enumerate(lines):
        if re.fullmatch(r'##\s+\d+\.\d+\.\d+\s*', line):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r'##\s', lines[j]):
            end = j
            break
    return '\n'.join(lines[:start] + lines[end:])

try:
    base = text(os.environ['BASE_FILE'])
    branch = text(os.environ['BRANCH_FILE'])
    if kind == 'log':
        cut = without_top(branch)
        ok = cut is not None and (cut == base or cut == without_top(base))
    else:
        ok = manifest(base, kind == 'market') == manifest(branch, kind == 'market')
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
" 2>/dev/null || {
    rm -f "$basefile"
    say "refused: ${path} differs from ${BASE} in more than the version, and the lander writes only the version into it - landing this would delete the rest of that change without saying so"
    exit 5; }
done

rm -f "$basefile"

entry=$(mktemp "${TMPDIR:-/tmp}/plugin-entry.XXXXXX")
one=$(mktemp "${TMPDIR:-/tmp}/plugin-entry-one.XXXXXX")
trap 'rm -f "$entry" "$one"' EXIT

has_text() { grep -q '[^[:space:]]' "$1" 2>/dev/null; }

if [ -n "$ENTRY_FILE" ] && [ -s "$ENTRY_FILE" ]; then
  cat "$ENTRY_FILE" > "$entry"
else
  for num in $PRS; do
    : > "$one"
    [ -z "$SLUG" ] || gh pr view "$num" --repo "$SLUG" --json title,body 2>/dev/null | HEADING="$HEADING" python3 -c "
import json,os,re,sys
try:
    pr = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
body = (pr.get('body') or '').replace('\r\n', '\n')
want = os.environ['HEADING'].lstrip('#').strip().lower()
lines = body.split('\n')
start = None
for i, line in enumerate(lines):
    m = re.match(r'^#{2,6}\s*(.+?)\s*$', line)
    if m and m.group(1).strip().lower() == want:
        start = i + 1
        break
out = []
if start is not None:
    for line in lines[start:]:
        if re.match(r'^#{1,6}\s', line):
            break
        out.append(line)
text = '\n'.join(out).strip()
print(text or (pr.get('title') or '').strip())
" 2>/dev/null > "$one"
    has_text "$one" || {
      say "refused: no changelog text could be read for pull request #${num}, and a version that moves with nothing under its heading is the release note this exists to deliver"
      exit 5; }
    [ -s "$entry" ] && printf '\n' >> "$entry"
    cat "$one" >> "$entry"
  done
fi

has_text "$entry" || {
  say "refused: no changelog text could be read for ${PRS:-this branch}, and a version that moves with nothing under its heading is the release note this exists to deliver"
  exit 5; }

for path in "$MARKETPLACE" "$PLUGIN" "$LOG"; do
  git cat-file -e "${BASE}:${path}" 2>/dev/null || continue
  git checkout "$BASE" -- "$path" >/dev/null 2>/dev/null || {
    say "refused: ${path} could not be restored from ${BASE}"; exit 5; }
done

if ! NEXT="$next_version" PLUGIN_PATH="$PLUGIN" MARKET_PATH="$MARKETPLACE" python3 -c "
import json,os,sys
nxt = os.environ['NEXT']
plugin_path = os.environ['PLUGIN_PATH']
market_path = os.environ['MARKET_PATH']
with open(plugin_path) as f:
    plugin = json.load(f)
with open(market_path) as f:
    market = json.load(f)
entries = [p for p in market.get('plugins') or [] if p.get('name') == 'devloop']
if not entries:
    sys.exit(1)
plugin['version'] = nxt
for e in entries:
    e['version'] = nxt
with open(plugin_path, 'w') as f:
    f.write(json.dumps(plugin, indent=2, ensure_ascii=False) + '\n')
with open(market_path, 'w') as f:
    f.write(json.dumps(market, indent=2, ensure_ascii=False) + '\n')
" 2>/dev/null; then
  say "refused: ${MARKETPLACE} has no plugin entry named devloop, so the two manifests cannot be made to agree"
  exit 5
fi

NEXT="$next_version" ENTRY="$entry" LOG_PATH="$LOG" python3 -c "
import os
path = os.environ['LOG_PATH']
nxt = os.environ['NEXT']
try:
    with open(path) as f:
        old = f.read()
except FileNotFoundError:
    old = '# Changelog\n'
text = open(os.environ['ENTRY']).read().strip()
head, sep, rest = old.partition('\n## ')
rest = (sep + rest).lstrip('\n') if sep else ''
block = '## %s\n' % nxt
if text:
    block += '\n%s\n' % text
with open(path, 'w') as f:
    f.write('%s\n\n%s%s' % (head.rstrip('\n'), block, ('\n' + rest) if rest else ''))
"

commit_triple <<EOF
Set devloop plugin version ${next_version}

Assigned at merge time from ${BASE}, which held ${master_version}. A branch does not
pick this number: every branch that reads master and bumps picks the same one, and all
but the first to land are then equal to master rather than greater.
EOF
commit_code=$?

case "$commit_code" in
  0) say "assigned: devloop plugin version ${next_version}, up from ${BASE}'s ${master_version}" ;;
  2) say "assigned: devloop plugin version ${next_version} is already committed on this branch, up from ${BASE}'s ${master_version} - nothing to add" ;;
  *) say "refused: the commit carrying ${next_version} was rejected, so the three files do not agree on any version this can land"
     exit 5 ;;
esac

say "files: ${MARKETPLACE} ${PLUGIN} ${LOG}"
exit 0
