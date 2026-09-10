#!/bin/bash

set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_SCRIPTS="task.js land.js rework.js land-train.js"
STAGE_NAME=".autofix-run"

usage() {
  cat >&2 <<USAGE
usage: run-script.sh [<script>]

Copies every workflow script - $RUN_SCRIPTS - from this
install into <root>/$STAGE_NAME, and prints the absolute path of <script> so it
can be passed to the Workflow tool as scriptPath. Named with no script, it stages
them and prints nothing.

The copy is unconditional: nothing is compared, nothing is version-checked, and a
copy already there is replaced. Dispatch through config.sh --args or --land and
this runs for you.
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

WANTED="${1:-}"
if [ -n "$WANTED" ]; then
  case " $RUN_SCRIPTS " in
    *" $WANTED "*) ;;
    *)
      echo "run-script.sh: '$WANTED' is not a workflow script - have: $RUN_SCRIPTS" >&2
      exit 2 ;;
  esac
fi

ROOT="$(bash "$SKILL_DIR/config.sh" root)" || exit 1
if [ ! -d "$ROOT" ]; then
  echo "run-script.sh: root '$ROOT' is not a directory - nothing can be staged there." >&2
  exit 1
fi

STAGE="$ROOT/$STAGE_NAME"
mkdir -p "$STAGE" || exit 1

for script in $RUN_SCRIPTS; do
  [ -f "$SKILL_DIR/$script" ] || {
    echo "run-script.sh: $script is missing from this install at $SKILL_DIR." >&2
    exit 1
  }
  tmp="$STAGE/.$script.staging.$$"
  cp "$SKILL_DIR/$script" "$tmp" || { rm -f "$tmp"; exit 1; }
  mv -f "$tmp" "$STAGE/$script" || { rm -f "$tmp"; exit 1; }
done

[ -n "$WANTED" ] && echo "$STAGE/$WANTED"
exit 0
