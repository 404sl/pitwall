#!/usr/bin/env bash
set -u

dir=""
branch=""
have_cmd=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir=*)    dir=${1#--dir=}; shift ;;
    --branch=*) branch=${1#--branch=}; shift ;;
    --dir)      [ $# -ge 2 ] || { echo "git-guard.sh: --dir takes a value" >&2; exit 2; }; dir=$2; shift 2 ;;
    --branch)   [ $# -ge 2 ] || { echo "git-guard.sh: --branch takes a value" >&2; exit 2; }; branch=$2; shift 2 ;;
    --)         shift; have_cmd=1; break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$dir" ]; then
  echo "git-guard.sh: --dir is required. Refusing to guess which checkout the command runs in." >&2
  exit 2
fi

if [ -z "$branch" ]; then
  echo "git-guard.sh: --branch is required. Refusing to guess which branch the caller believes it is on." >&2
  exit 2
fi

if [ "$have_cmd" = 0 ] || [ $# -eq 0 ]; then
  echo "git-guard.sh: no command after --. Nothing to guard and nothing was run." >&2
  exit 2
fi

case "$branch" in
  master|main|refs/heads/master|refs/heads/main)
    echo "REFUSED" >&2
    echo "git-guard.sh: --branch is ${branch}, which is a default branch. Nothing was run." >&2
    echo "              Committing or pushing there is the one action this guard exists to stop," >&2
    echo "              and a caller that names it has already lost track of where it is." >&2
    exit 2 ;;
esac

if [ ! -d "$dir" ]; then
  echo "REFUSED" >&2
  echo "git-guard.sh: ${dir} is not a directory, so the command would run wherever the caller" >&2
  echo "              happened to be standing. Nothing was run." >&2
  exit 2
fi

want=$(cd "$dir" && pwd -P)
top=$(git -C "$dir" rev-parse --show-toplevel || true)
[ -n "$top" ] && top=$(cd "$top" && pwd -P)

if [ -z "$top" ]; then
  echo "REFUSED" >&2
  echo "git-guard.sh: git reported no worktree root for ${dir}, so where the command would run" >&2
  echo "              is unknown. Nothing was run. Any git error above this line is the reason -" >&2
  echo "              an unreadable global config fails here exactly like a directory that is" >&2
  echo "              not a checkout." >&2
  exit 2
fi

if [ "$top" != "$want" ]; then
  echo "REFUSED" >&2
  echo "git-guard.sh: ${dir} sits inside the worktree rooted at ${top}, not at its own root. That is" >&2
  echo "              how a command meant for a lane's worktree reaches a main checkout instead." >&2
  echo "              Nothing was run." >&2
  exit 2
fi

head=$(git -C "$dir" symbolic-ref --quiet --short HEAD || true)

if [ -z "$head" ]; then
  echo "REFUSED" >&2
  echo "git-guard.sh: ${dir} is on a detached HEAD, so there is no branch to check ${branch} against." >&2
  echo "              Nothing was run." >&2
  exit 2
fi

if [ "$head" != "$branch" ]; then
  echo "REFUSED" >&2
  echo "git-guard.sh: ${dir} is on ${head} and the caller believes it is on ${branch}. Nothing was run." >&2
  echo "              A push from the wrong branch is the failure this guard exists to stop, and the" >&2
  echo "              disagreement is the evidence that a cd went somewhere it was not meant to." >&2
  exit 2
fi

cd "$dir" || exit 2
exec "$@"
