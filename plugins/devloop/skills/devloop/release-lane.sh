#!/usr/bin/env bash
set -u

lane=""
slot=""
owner=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lane)  lane=$2; shift 2 ;;
    --slot)  slot=$2; shift 2 ;;
    --owner) owner=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$lane" ]; then
  echo "release-lane.sh: --lane is required. Refusing to guess which workspace's lane lock to remove." >&2
  exit 2
fi

case "$lane" in
  *-lane-*.lock) ;;
  *)
    echo "REFUSED" >&2
    echo "release-lane.sh: --lane is ${lane}, which is not a <prefix>-lane-<n>.lock path, so it is not a" >&2
    echo "                 lane lock and nothing was removed. A mis-derived path is the one mistake here" >&2
    echo "                 that costs more than a leak." >&2
    exit 2 ;;
esac

if [ -z "$owner" ]; then
  echo "REFUSED" >&2
  echo "release-lane.sh: --owner is empty, so ownership of ${lane} cannot be proved and nothing was removed." >&2
  echo "                 An empty id matches an owner file that is missing or empty, which is exactly what" >&2
  echo "                 another lane's lock looks like between its mkdir and the line that records it." >&2
  exit 2
fi

case "$owner" in
  *[!A-Za-z0-9._-]*)
    echo "REFUSED" >&2
    echo "release-lane.sh: --owner carries characters no issue id does, so it is not an id a lane wrote." >&2
    echo "                 Nothing was removed. Read ${lane%.lock}.owner by hand." >&2
    exit 2 ;;
esac

ownerfile="${lane%.lock}.owner"
held="$(awk 'NR == 1 { print $1 }' "$ownerfile" 2>/dev/null || true)"
status=0

if [ -e "$lane" ] && [ ! -d "$lane" ]; then
  echo "lane: STILL_HELD"
  echo "  ${lane} is a regular file, not a directory. mkdir can never succeed against it, so that lane is"
  echo "  blocked for good rather than until a run finishes. Nothing was removed: a file there is a fault"
  echo "  to report, not a lane that happens to be busy."
  status=1
elif [ ! -d "$lane" ]; then
  [ -n "$held" ] && [ "$held" = "$owner" ] && rm -f "$ownerfile"
  echo "lane: ALREADY_GONE"
  echo "  ${lane} does not exist. Nothing to remove - a handoff or another release took it."
elif [ "$held" != "$owner" ]; then
  echo "lane: NOT_MINE"
  echo "  ${ownerfile} records [${held}] and this run is [${owner}], so nothing was removed. An empty"
  echo "  reading means no owner file, which is how a lock looks between another lane's mkdir and the"
  echo "  line that records it. That is an outcome, not a failure: whatever holds it gives it back itself."
elif rm -f "$ownerfile" && rmdir "$lane"; then
  echo "lane: RELEASED"
  echo "  ${lane} recorded ${owner} and has been removed."
else
  echo "lane: STILL_HELD"
  echo "  ${lane} recorded ${owner} and could not be removed - rmdir refuses a directory that is not"
  echo "  empty, and a lane lock is meant to be bare. Read what is inside it before clearing it by hand."
  status=1
fi

if [ -n "$slot" ]; then
  claim="$(cat "$slot" 2>/dev/null || true)"
  claim="${claim%%[[:space:]]*}"
  if [ ! -e "$slot" ]; then
    echo "slot: ALREADY_GONE"
    echo "  ${slot} does not exist. The reservation was given back already."
  elif [ "$claim" != "$owner" ]; then
    echo "slot: NOT_MINE"
    echo "  ${slot} names [${claim}] and this run is [${owner}], so nothing was removed."
  elif rm -f "$slot"; then
    echo "slot: RELEASED"
    echo "  ${slot} named ${owner} and has been removed."
  else
    echo "slot: STILL_HELD"
    echo "  ${slot} named ${owner} and could not be removed. The lane stays reserved."
    status=1
  fi
fi

exit $status
