#!/bin/bash
# Fail if a brand asset carries embedded generator provenance.
#
# WHY THIS EXISTS. The logo SVGs arrived with C2PA manifests embedded in them - a
# base64 blob in the first kilobyte naming the tool that produced the file. Nothing
# renders it, so it survived a review that read the stylesheet and the README
# closely, and it reached this PUBLIC repository before anybody opened a raw .svg.
# Rasterising drops it; copying a file does not.
#
# It checks for the PROVENANCE FORMAT and deliberately not for any vendor name.
# Product documentation and user-facing strings may name the tools this software
# integrates with - that is a separate and settled question. What is not wanted is
# metadata nobody chose to write, travelling inside an asset.
set -uo pipefail
cd "$(dirname "$0")/.."

found=0
while IFS= read -r f; do
  if grep -aqiE 'c2pa|jumdc2pa|c2pa\.assertions' "$f" 2>/dev/null; then
    echo "  provenance metadata in $f"
    found=1
  fi
done < <(find ui/brand -type f \( -name '*.svg' -o -name '*.png' -o -name '*.ico' -o -name '*.json' \) 2>/dev/null)

if [ "$found" -ne 0 ]; then
  cat <<'MSG'

Brand assets carry embedded provenance metadata.

Strip it before committing, and confirm the render is unchanged rather than
assuming it. The source of truth is brand/ in the internal documentation
repository, whose generate.sh produces clean rasters from clean SVGs.
MSG
  exit 1
fi
echo "  brand assets carry no embedded provenance"
