#!/bin/bash
set -u

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=""
dir=""
origin=""
case "${1:-}" in
  --checkout) [ $# -ge 2 ] || { echo "default-branch.sh: --checkout takes a directory" >&2; exit 2; }; mode=checkout; dir=$2 ;;
  --all) mode=all ;;
  *) echo "usage: default-branch.sh --checkout <dir> | --all   (prints master when the config, the repo or its defaultBranch is absent)" >&2; exit 2 ;;
esac

if [ "$mode" = "checkout" ]; then
  dir="$(cd "$dir" 2>/dev/null && pwd -P)" || { echo master; exit 0; }
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  cfg="$(cd "$dir" && bash "$skill/config.sh" 2>/dev/null)" || { echo master; exit 0; }
else
  cfg="$(bash "$skill/config.sh" 2>/dev/null)" || { echo master; exit 0; }
fi

CFG_JSON="$cfg" python3 - "$mode" "$dir" "$origin" <<'PY'
import json, os, sys
try:
    cfg = json.loads(os.environ.get("CFG_JSON") or "")
except Exception:
    print("master"); sys.exit(0)
mode, want, origin = sys.argv[1:4]
repos = cfg.get("repos") if isinstance(cfg, dict) else None
if not isinstance(repos, dict):
    repos = {}

def branch(r):
    b = (r or {}).get("defaultBranch") if isinstance(r, dict) else None
    return b if isinstance(b, str) and b.strip() else "master"

if mode == "all":
    seen = []
    for r in repos.values():
        b = branch(r)
        if b not in seen:
            seen.append(b)
    print("\n".join(seen or ["master"])); sys.exit(0)

root = cfg.get("root") if isinstance(cfg.get("root"), str) else ""
if root:
    for name, r in repos.items():
        rel = (r or {}).get("path") if isinstance(r, dict) else None
        if os.path.realpath(os.path.join(root, rel or name)) == os.path.realpath(want):
            print(branch(r)); sys.exit(0)
slug = origin.rstrip("/").removesuffix(".git").split("github.com")[-1].lstrip(":/") if "github.com" in origin else ""
if slug:
    for r in repos.values():
        if isinstance(r, dict) and r.get("slug") == slug:
            print(branch(r)); sys.exit(0)
print("master")
PY
