#!/bin/bash
# Run rspec and print only what a reader actually needs, without ever dropping a locator.
#
# WHY NOT rtk. rtk's rspec filter runs `--format json`, and this project's .rspec already forces
# `--format documentation`, so rspec emits both and rtk's parse dies at column 0. It then falls
# back to "show the last 5 lines", which here is the SimpleCov coverage report - so the run
# reports neither the counts nor the failures. Its generic `rtk test` wrapper fails the same way
# for the same reason: a fixed tail window only works when the suite is the last thing to speak.
#
# WHAT THIS KEEPS, and the order matters because it is the order a reader wants:
#   1. the counts line - "N examples, M failures" - which is the one fact the step exists for
#   2. EVERY line of the "Failed examples:" block, never truncated, however many there are
#   3. a bounded excerpt of each failure message
#   4. the path to the full log, so anything trimmed is still recoverable
#
# Point 3 is where the saving is. A failed `have_content` prints the ENTIRE page text: one such
# failure was 18 KB of importmap JSON and sidebar markup, a quarter of a 74 KB CI log, and it
# said nothing the assertion line had not already said.
#
# Usage:  rspec-quiet.sh [any rspec arguments]
#         RSPEC_QUIET_EXCERPT=12   lines kept per failure message (default 8)
#         RSPEC_QUIET_FULL=1       print everything, i.e. behave like plain rspec
#
# Exit code is rspec's own, untouched - callers branch on it.

set -u

EXCERPT="${RSPEC_QUIET_EXCERPT:-8}"
LOGDIR="${TMPDIR:-/tmp}/rspec-quiet"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/run-$$.log"

bundle exec rspec "$@" > "$LOG" 2>"$LOG.err"
code=$?

if [ "${RSPEC_QUIET_FULL:-0}" = "1" ]; then
  cat "$LOG"
  exit $code
fi

python3 - "$LOG" "$EXCERPT" "$code" <<'PY'
import re, sys

log, excerpt, code = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = open(log, encoding='utf-8', errors='replace').read().split('\n')

# The counts. There can be more than one when a suite retries, so keep them all rather than
# guessing which is authoritative.
counts = [l.strip() for l in lines
          if re.match(r'^\s*\d+ examples?, \d+ (failures?|failure)', l)]

# The locator block - NEVER truncated. This is what rtk drops, and it is the whole point.
#
# Matches any path, not just a './' one. rspec prints the path as it was given, so an absolute
# invocation produces 'rspec /Users/.../thing_spec.rb:12'. An earlier version of this line
# required './' and silently reported no failures at all for those runs, which is precisely the
# defect this script exists to avoid.
locators = [l.strip() for l in lines if re.match(r'^\s*rspec\s+\S+:\d+', l)]

# Failure messages, each cut to a bounded excerpt. A Capybara page dump lands on ONE enormous
# line, so lines are clipped as well as counted.
failures, cur = [], None
for l in lines:
    if re.match(r'^\s*\d+\)\s', l):
        if cur: failures.append(cur)
        cur = [l.rstrip()]
    elif cur is not None:
        if re.match(r'^\s*(Finished in|\d+ examples?,|Failed examples:)', l):
            failures.append(cur); cur = None
        else:
            cur.append(l.rstrip())
if cur: failures.append(cur)

out = []
if counts:
    out += counts
else:
    out.append('(no rspec summary line found - the run may not have reached the end)')

for f in failures:
    kept = [x for x in f if x.strip()][:excerpt]
    for k in kept:
        out.append(k[:300] + (' ...[clipped]' if len(k) > 300 else ''))
    if len([x for x in f if x.strip()]) > excerpt:
        out.append('   ...[%d more lines in the full log]' % (len([x for x in f if x.strip()]) - excerpt))
    out.append('')

if locators:
    out.append('Failed examples (%d, all shown):' % len(locators))
    out += ['  ' + l for l in locators]

out.append('')
out.append('exit %s | full log: %s' % (code, log))
print('\n'.join(out))
PY

exit $code
