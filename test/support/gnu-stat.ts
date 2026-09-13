import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gnuStatOnPath(): string {
  const real = spawnSync("/bin/sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
  const bin = mkdtempSync(join(tmpdir(), "pitwall-gnu-stat-"));
  const stub = join(bin, "stat");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `real=${real}`,
      'case "$1" in',
      "  -c)",
      '    fmt=$2; shift 2',
      '    [ "$fmt" = "%Y" ] || { echo "stat: invalid directive" >&2; exit 1; }',
      '    for f in "$@"; do "$real" -c %Y "$f" 2>/dev/null || "$real" -f %m "$f"; done ;;',
      "  -f)",
      "    shift; status=0",
      '    for f in "$@"; do',
      '      if [ -e "$f" ]; then',
      `        printf '  File: "%s"\\n    ID: 0 Namelen: 255 Type: ext2/ext3\\nBlock size: 4096\\n' "$f"`,
      "      else",
      `        echo "stat: cannot read file system information for '$f': No such file or directory" >&2`,
      "        status=1",
      "      fi",
      "    done",
      "    exit $status ;;",
      `  *) echo "stat: invalid option -- '$1'" >&2; exit 1 ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  const path = process.env["PATH"];
  return path === undefined ? bin : `${bin}:${path}`;
}
