#!/bin/bash

set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_SCRIPTS="task.js land.js rework.js land-train.js"
STAGE_NAME=".autofix-run"
RECORD_NAME="staged-from"

usage() {
  cat >&2 <<USAGE
usage: run-script.sh [--restage] [<script>]

Copies every workflow script - $RUN_SCRIPTS - from this
install into <root>/$STAGE_NAME, and prints the absolute path of <script> so it
can be passed to the Workflow tool as scriptPath. Named with no script, it stages
them and prints nothing.

Beside the copies it writes $RECORD_NAME: the install it copied from, that
install's plugin version, when, and each copy's byte count and sha256. Before it
copies anything it reads the record already there and compares every staged copy
with the digest recorded for it. A copy that differs was replaced by something
other than this script since it was staged, and staging stops with exit 3, naming
the file and both versions, leaving the stage as it found it: nothing runs from it
and nothing covers it over. A stage with no record is copied over without question.

--restage skips that comparison. A copy you replaced on purpose, or one the
refusal named after you have read it, is simply copied again. Dispatch through
config.sh --args or --land and this runs for you, never with --restage.
USAGE
}

RESTAGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --restage) RESTAGE=1; shift ;;
    --) shift; break ;;
    -*)
      echo "run-script.sh: unknown option '$1'" >&2
      usage
      exit 2 ;;
    *) break ;;
  esac
done

WANTED="${1:-}"
if [ -n "$WANTED" ]; then
  case " $RUN_SCRIPTS " in
    *" $WANTED "*) ;;
    *)
      echo "run-script.sh: '$WANTED' is not a workflow script - have: $RUN_SCRIPTS" >&2
      exit 2 ;;
  esac
fi

digest() {
  shasum -a 256 "$1" | awk '{print $1}'
}

bytes() {
  wc -c < "$1" | tr -d ' '
}

plugin_version() {
  local manifest="$1/../../.claude-plugin/plugin.json" v=""
  if [ -f "$manifest" ]; then
    v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  fi
  echo "${v:-unknown}"
}

record_field() {
  awk -v key="$2" '$1 == key { sub(/^[^ ]+ /, ""); print; exit }' "$1"
}

ROOT="$(bash "$SKILL_DIR/config.sh" root)" || exit 1
if [ ! -d "$ROOT" ]; then
  echo "run-script.sh: root '$ROOT' is not a directory - nothing can be staged there." >&2
  exit 1
fi

STAGE="$ROOT/$STAGE_NAME"
mkdir -p "$STAGE" || exit 1
RECORD="$STAGE/$RECORD_NAME"
THIS_VERSION="$(plugin_version "$SKILL_DIR")"

if [ "$RESTAGE" -eq 0 ] && [ -f "$RECORD" ]; then
  recorded_source="$(record_field "$RECORD" source)"
  recorded_version="$(record_field "$RECORD" version)"
  for script in $RUN_SCRIPTS; do
    [ -f "$STAGE/$script" ] || continue
    entry="$(record_field "$RECORD" "$script")"
    [ -n "$entry" ] || continue
    recorded_bytes="${entry%% *}"
    recorded_digest="${entry##* }"
    [ "$(digest "$STAGE/$script")" = "$recorded_digest" ] && continue
    echo "run-script.sh: $STAGE/$script is not the copy staged from ${recorded_version:-unknown} at ${recorded_source:-an unrecorded install} ($(bytes "$STAGE/$script") bytes now, $recorded_bytes bytes when staged) and this install is $THIS_VERSION at $SKILL_DIR - refusing to run it or cover it over. Read it, then re-stage on purpose: bash $SKILL_DIR/run-script.sh --restage" >&2
    exit 3
  done
fi

for script in $RUN_SCRIPTS; do
  [ -f "$SKILL_DIR/$script" ] || {
    echo "run-script.sh: $script is missing from this install at $SKILL_DIR." >&2
    exit 1
  }
done

rm -f "$RECORD"
record_tmp="$STAGE/.$RECORD_NAME.staging.$$"
{
  echo "source $SKILL_DIR"
  echo "version $THIS_VERSION"
  echo "staged $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$record_tmp" || { rm -f "$record_tmp"; exit 1; }

for script in $RUN_SCRIPTS; do
  tmp="$STAGE/.$script.staging.$$"
  cp "$SKILL_DIR/$script" "$tmp" || { rm -f "$tmp" "$record_tmp"; exit 1; }
  mv -f "$tmp" "$STAGE/$script" || { rm -f "$tmp" "$record_tmp"; exit 1; }
  cmp -s "$SKILL_DIR/$script" "$STAGE/$script" || {
    echo "run-script.sh: $STAGE/$script does not match $SKILL_DIR/$script after copying it - the stage cannot be trusted." >&2
    rm -f "$record_tmp"
    exit 1
  }
  echo "$script $(bytes "$STAGE/$script") $(digest "$STAGE/$script")" >> "$record_tmp" || { rm -f "$record_tmp"; exit 1; }
done

mv -f "$record_tmp" "$RECORD" || { rm -f "$record_tmp"; exit 1; }

[ -n "$WANTED" ] && echo "$STAGE/$WANTED"
exit 0
