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
#   config.sh --args app-abc1       stage the workflow scripts through run-script.sh, reserve a
#                                   lane through slot.sh, and print the args object for a task.js
#                                   dispatch, carrying the scriptPath to dispatch. An optional
#                                   third argument is checked against the reservation, never used
#                                   instead of it.
#   config.sh --land [repo#n ...]   stage the workflow scripts and print the args object for a
#                                   land.js run, naming the pre-flighted PRs it is allowed to
#                                   merge and the scriptPath to dispatch
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
# WHERE THIS SKILL LIVES. The workflow scripts need it to invoke their siblings -
# lane-handoff.sh, rspec-quiet.sh - and they have no filesystem access to find it
# themselves, so it has to travel in the args object like everything else.
#
# It is DERIVED here rather than configured. This file sits beside those scripts by
# definition, and the install path carries a version segment that changes on every
# update, so anything written down would be wrong by the next release.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

sessions() {
  python3 - "$CONFIG" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1]))
s = cfg.get("sessions") or {}
project = os.path.basename(str(cfg.get("root", "")).rstrip("/")) or "project"
print(s.get("devloop") or f"{project}-devloop")
print(s.get("planning") or f"{project}-planning-session")
PY
}

case "${1:-}" in
  session)          sessions | sed -n 1p ;;
  planning-session) sessions | sed -n 2p ;;
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
if not (cfg.get("sessions") or {}).get("devloop"):
    _derived = os.path.basename(os.path.normpath(cfg.get("root") or _here)) + "-devloop"
    print(f"note: no \"sessions\" key, so the devloop session name is DERIVED as '{_derived}',\n"
          "      from this workspace's DIRECTORY. Dispatch filters on the assignee, so a live\n"
          "      session spelled even one hyphen differently reads an EMPTY QUEUE rather than an\n"
          "      error, and a backfill would then assign the whole tracker to a name nothing\n"
          "      reads. Compare the derived name against the name this workspace's session\n"
          "      actually has, and when they differ set\n"
          "      \"sessions\": { \"devloop\": ..., \"planning\": ... } rather than renaming a session.")
if bad:
    print("\n".join("  " + b for b in bad)); sys.exit(1)
print(f"  config OK: {len(cfg.get('repos') or {})} repos, idPrefix '{cfg.get('idPrefix')}', "
      f"lockPrefix '{cfg.get('lockPrefix')}'")
PY
    ;;
  --args)
    # config.sh --args <issue-id> [slot]  ->  the args object for a task.js dispatch
    [ $# -ge 2 ] || { echo "usage: config.sh --args <issue-id> [slot]" >&2; exit 2; }
    SCRIPT_PATH="$(PITWALL_CONFIG="$CONFIG" bash "$SKILL_DIR/run-script.sh" task.js)" || {
      echo "config.sh --args: run-script.sh could not stage task.js - dispatch stops." >&2
      exit 1
    }
    SLOT="$(PITWALL_CONFIG="$CONFIG" bash "$SKILL_DIR/slot.sh" "$2")" || {
      echo "config.sh --args: slot.sh would not reserve a lane for $2 - dispatch stops." >&2
      exit 1
    }
    case "$SLOT" in
      ''|*[!0-9]*)
        echo "config.sh --args: slot.sh printed '$SLOT', which is not a lane number - dispatch stops." >&2
        exit 1 ;;
    esac
    if [ $# -ge 3 ] && [ "$3" != "$SLOT" ]; then
      echo "config.sh --args: $2 holds slot $SLOT, not $3. Re-run without a number; the" >&2
      echo "                  reservation decides the lane and is not overridden from here." >&2
      exit 1
    fi
    python3 - "$CONFIG" "$2" "$SLOT" "$SKILL_DIR" "$SCRIPT_PATH" "$(sessions | sed -n 1p)" "$(sessions | sed -n 2p)" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
print(json.dumps({
    "id": sys.argv[2],
    "slot": int(sys.argv[3]),
    "skillDir": sys.argv[4],
    "scriptPath": sys.argv[5],
    "root": cfg["root"],
    "idPrefix": cfg.get("idPrefix", "sr"),
    "lockPrefix": cfg.get("lockPrefix", "devloop"),
    "session": sys.argv[6],
    "planningSession": sys.argv[7],
    "repos": cfg.get("repos", {}),
}))
PY
    ;;
  --land)
    # Any trailing arguments are the PRs the supervisor pre-flighted, as owner/name#number,
    # and are passed through as 'preflighted'. land.js merges only those. A key of "repos"
    # below is accepted too and is rewritten to that repository's slug, because the slug is
    # what land.js keys its survey on - and a repository matching nothing filters that PR out
    # silently, so this refuses rather than printing a config that quietly lands less than the
    # caller meant.
    #
    # GIVEN NONE, THE FIELD IS OMITTED, which land.js reads as do-not-filter. That is the
    # old behaviour and it is safe; an empty list would instead mean land nothing.
    shift
    SCRIPT_PATH="$(PITWALL_CONFIG="$CONFIG" bash "$SKILL_DIR/run-script.sh" land.js)" || {
      echo "config.sh --land: run-script.sh could not stage land.js - the lander does not start." >&2
      exit 1
    }
    SESSION="$(sessions | sed -n 1p)"
    PLANNING="$(sessions | sed -n 2p)"
    python3 - "$CONFIG" "$SKILL_DIR" "$SCRIPT_PATH" "$SESSION" "$PLANNING" "$@" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
repos = cfg.get("repos", {})
out = {
    "skillDir": sys.argv[2],
    "scriptPath": sys.argv[3],
        "root": cfg["root"],
    "idPrefix": cfg.get("idPrefix", "sr"),
    "lockPrefix": cfg.get("lockPrefix", "devloop"),
    "session": sys.argv[4],
    "planningSession": sys.argv[5],
    "deployEvery": cfg.get("deployEvery", 3),
    "repos": repos,
}
slugs = {name: (r or {}).get("slug") for name, r in repos.items()}
known = sorted({s for s in slugs.values() if s})
pre = []
for a in sys.argv[6:]:
    a = a.strip()
    if not a:
        continue
    where, sep, num = a.rpartition("#")
    if not sep or not num.isdigit() or not where:
        sys.stderr.write("pre-flighted PR must be owner/name#number, got: %s\n" % a); sys.exit(2)
    slug = slugs.get(where, where)
    if not slug:
        sys.stderr.write("repository %s has no slug in this config - add slug: \"owner/name\" to it\n"
                         % where); sys.exit(2)
    if repos and slug not in known:
        sys.stderr.write("no repository %s in this config - have: %s\n"
                         % (where, ", ".join(known))); sys.exit(2)
    pre.append("%s#%d" % (slug, int(num)))
if pre:
    out["preflighted"] = pre
print(json.dumps(out))
PY
    ;;
  "") cat "$CONFIG" ;;
  *)  read_field "$1" ;;
esac
