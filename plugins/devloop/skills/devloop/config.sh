#!/bin/bash
# Read this workspace's .autofix.json and print what the caller asked for.
#
# WHY THIS EXISTS. Workflow scripts have NO FILESYSTEM ACCESS - task.js and land.js cannot read
# a config file themselves, only what arrives in `args`. So the config is read out here, by the
# supervisor, and passed in. That is the whole trick, and it is why the alternative (a copy of
# the skill per project) was rejected: of task.js's 1123 lines only 56 mention any project's
# tools, and the other 95% includes 61 lines that each record a specific past failure. Copies
# fork that lore; a config file does not.
#
# Usage:
#   config.sh                       print the whole config as JSON
#   config.sh root                  print one top-level field
#   config.sh repos.site.test       print a nested field
#   config.sh --args app-abc1 3      print the args object for a task.js dispatch
#   config.sh --land [repo#n ...]   print the args object for a land.js run, naming the
#                                   pre-flighted PRs it is allowed to merge
#   config.sh --check               validate the file and report what is missing
#
# WHERE IT LOOKS, in order: $DEVLOOP_CONFIG, then .autofix.json walking up from the cwd. Walking
# up rather than demanding an absolute path means it works from inside any repo of the workspace,
# which is where the supervisor usually is.

set -u

# TWO FILENAMES, DURING A MIGRATION. `.pitwall.json` is the name going forward;
# `.autofix.json` is what every workspace on this machine is called today and keeps
# working.
#
# Read order matters and is per DIRECTORY, not per name: the first directory walking up
# that has EITHER file wins, and within that directory `.pitwall.json` is preferred. The
# alternative - scanning all the way up for the new name and only then starting again for
# the old - would let a distant parent's new-style config beat the old-style one sitting
# in the workspace you are actually in.
#
# Both present in one directory is not an error: it is what a migration looks like
# mid-way. The new one wins and `--check` says the old one is now dead weight.
#
# The environment override still names one file explicitly and is unaffected. It keeps
# its old variable name deliberately - renaming a variable that people have in shell
# profiles and dispatch scripts breaks them silently, and it costs nothing to leave.
CONFIG_NAMES=".pitwall.json .autofix.json"

find_config() {
  if [ -n "${PITWALL_CONFIG:-${DEVLOOP_CONFIG:-}}" ]; then
    local explicit="${PITWALL_CONFIG:-$DEVLOOP_CONFIG}"
    [ -f "$explicit" ] && { echo "$explicit"; return 0; }
    echo "config override points at $explicit, which does not exist" >&2
    return 1
  fi
  local d="$PWD" n
  while [ "$d" != "/" ]; do
    for n in $CONFIG_NAMES; do
      [ -f "$d/$n" ] && { echo "$d/$n"; return 0; }
    done
    d=$(dirname "$d")
  done
  echo "no .pitwall.json or .autofix.json found in $PWD or any parent" >&2
  return 1
}

CONFIG=$(find_config) || exit 1

# jq is not assumed; python3 is already required by queue.sh and triage-scan.sh.
read_field() {
  python3 - "$CONFIG" "$1" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
node = cfg
for part in sys.argv[2].split('.'):
    if not isinstance(node, dict) or part not in node:
        sys.stderr.write(f"no such field: {sys.argv[2]}\n"); sys.exit(1)
    node = node[part]
print(node if isinstance(node, str) else json.dumps(node))
PY
}

case "${1:-}" in
  --check)
    python3 - "$CONFIG" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1]))
bad = []
for f in ("root", "idPrefix", "lockPrefix", "repos"):
    if f not in cfg: bad.append(f"missing top-level field: {f}")
root = cfg.get("root", "")
if root and not os.path.isdir(root): bad.append(f"root does not exist: {root}")
if root and not os.path.isdir(os.path.join(root, ".beads")):
    bad.append(f"no .beads tracker at {root}")
for name, r in (cfg.get("repos") or {}).items():
    p = os.path.join(root, r.get("path", name))
    if not os.path.isdir(p): bad.append(f"repo {name}: no directory at {p}")
    elif not os.path.isdir(os.path.join(p, ".git")): bad.append(f"repo {name}: {p} is not a git repo")
    if not r.get("test"): bad.append(f"repo {name}: no test command - a lane cannot verify its own work")
# THE PREFIX IS KEYED TO THE APPLICATION, NOT TO THE PIPELINE, and getting that backwards is
# the one misconfiguration here that fails silently.
#
# What a lane lock protects is a test database, and a database is named after the app that owns
# it - example_app_test3, seo_directories_test3. So the rule cuts both ways:
#
#   different applications, same prefix   -> lanes block each other over nothing. Wasteful, loud,
#                                            harmless.
#   same application, different prefixes  -> both pipelines hand out that app's test3 from
#                                            separate lock namespaces and the lock stops
#                                            protecting anything. SILENT: a suite whose database
#                                            is reset under it fails in files nobody touched,
#                                            which reads as flakiness rather than as a lock bug.
#
# The second is the dangerous one and the one nobody thinks to check, because it only appears
# when a SECOND pipeline is pointed at a repository that already has one - a second checkout, a
# fork, another machine-local pipeline. See app-8yyz, which measured it and decided the rename was
# not worth making unilaterally.
# Migration notice. Reported here rather than on every read, because this file is called
# by every script many times a run and a deprecation warning on stdout would corrupt the
# machine-readable output while one on stderr would train everyone to ignore stderr.
import os
_here = os.path.dirname(os.path.abspath(sys.argv[1]))
_old, _new = os.path.join(_here, ".autofix.json"), os.path.join(_here, ".pitwall.json")
if os.path.basename(sys.argv[1]) == ".autofix.json":
    print("note: this workspace still uses .autofix.json. The name going forward is\n"
          "      .pitwall.json; both are read, the new one wins, and nothing breaks today.\n"
          "      Rename when convenient - the fallback is a migration aid, not a feature.")
elif os.path.exists(_old) and os.path.exists(_new):
    print("note: both .pitwall.json and .autofix.json exist here. The new one is in use and\n"
          "      the old one is dead weight - delete it, or a later reader that drops the\n"
          "      fallback will find only a file nobody has updated.")
if cfg.get("lockPrefix") == "devloop":
    print("note: lockPrefix is the default 'devloop'. Fine while one pipeline owns this workspace.\n"
          "      Namespace it per APPLICATION, not per pipeline: two pipelines over DIFFERENT apps\n"
          "      need different prefixes, and two over the SAME app must share one, or the lane\n"
          "      lock silently stops guarding that app's test databases.")
if bad:
    print("\n".join("  " + b for b in bad)); sys.exit(1)
print(f"  config OK: {len(cfg.get('repos') or {})} repos, idPrefix '{cfg.get('idPrefix')}', "
      f"lockPrefix '{cfg.get('lockPrefix')}'")
PY
    ;;
  --args)
    # config.sh --args <issue-id> <slot>  ->  the args object for a task.js dispatch
    [ $# -ge 3 ] || { echo "usage: config.sh --args <issue-id> <slot>" >&2; exit 2; }
    python3 - "$CONFIG" "$2" "$3" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
print(json.dumps({
    "id": sys.argv[2],
    "slot": int(sys.argv[3]),
    "root": cfg["root"],
    "idPrefix": cfg.get("idPrefix", "sr"),
    "lockPrefix": cfg.get("lockPrefix", "devloop"),
    "repos": cfg.get("repos", {}),
}))
PY
    ;;
  --land)
    # Any trailing arguments are the PRs the supervisor pre-flighted, as repo#number, and
    # are passed through as 'preflighted'. land.js merges only those. The repo half must be
    # a key of "repos" below, not a GitHub slug, because that is what its survey reports -
    # and a name matching nothing filters that PR out silently, so this refuses rather than
    # printing a config that quietly lands less than the caller meant.
    #
    # GIVEN NONE, THE FIELD IS OMITTED, which land.js reads as do-not-filter. That is the
    # old behaviour and it is safe; an empty list would instead mean land nothing.
    shift
    python3 - "$CONFIG" "$@" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
repos = cfg.get("repos", {})
out = {
    "root": cfg["root"],
    "idPrefix": cfg.get("idPrefix", "sr"),
    "lockPrefix": cfg.get("lockPrefix", "devloop"),
    "deployEvery": cfg.get("deployEvery", 3),
    "repos": repos,
}
pre = []
for a in sys.argv[2:]:
    a = a.strip()
    if not a:
        continue
    name, sep, num = a.partition("#")
    if not sep or not num.isdigit() or not name:
        sys.stderr.write("pre-flighted PR must be repo#number, got: %s\n" % a); sys.exit(2)
    if repos and name not in repos:
        sys.stderr.write("no repository named %s in this config - have: %s\n"
                         % (name, ", ".join(sorted(repos)))); sys.exit(2)
    pre.append("%s#%d" % (name, int(num)))
if pre:
    out["preflighted"] = pre
print(json.dumps(out))
PY
    ;;
  "") cat "$CONFIG" ;;
  *)  read_field "$1" ;;
esac
