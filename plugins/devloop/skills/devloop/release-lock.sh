#!/usr/bin/env bash
set -u

lock=""
token=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lock)  lock=$2; shift 2 ;;
    --token) token=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$lock" ]; then
  echo "release-lock.sh: --lock is required. Refusing to guess which workspace's merge lock to remove." >&2
  exit 2
fi

if [ -z "$token" ]; then
  echo "REFUSED" >&2
  echo "release-lock.sh: --token is empty, so ownership of ${lock} cannot be proved and nothing was removed." >&2
  echo "               An empty token matches a holder file that is missing or empty, which is exactly what" >&2
  echo "               another lander's lock looks like between its mkdir and its printf." >&2
  exit 2
fi

case "$token" in
  *[!A-Za-z0-9._-]*)
    echo "REFUSED" >&2
    echo "release-lock.sh: --token contains characters no lander mints, so it is not a token this run wrote." >&2
    echo "               Nothing was removed. Read ${lock}/holder by hand." >&2
    exit 2 ;;
esac

if [ ! -d "$lock" ]; then
  echo "ALREADY_GONE"
  echo "${lock} does not exist. Nothing to remove - something released it while this run was working."
  exit 0
fi

holder=$(cat "$lock/holder" 2>/dev/null || true)

if [ "$holder" != "$token" ]; then
  echo "NOT_MINE"
  echo "${lock}/holder reads [${holder}] and this run wrote [${token}]. Nothing was removed."
  echo "That is an outcome, not a failure: whatever holds it now gives it back itself."
  exit 0
fi

if rm -rf "$lock"; then
  echo "RELEASED"
  echo "${lock} held [${token}] and has been removed."
  exit 0
fi

echo "STILL_HELD"
echo "${lock} held [${token}] and rm could not remove it. It is still standing."
exit 1
