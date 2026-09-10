<!-- THE MARK, NOT THE LOCKUP, and deliberately.
     The lockup and wordmark SVGs set live text in Barlow Condensed. GitHub does not have
     that font, falls back to something much wider, and the text overflows the viewBox and
     is CLIPPED - "pitwall.buil". The brand package says so in as many words: on a platform
     that cannot load the font, convert the text to outlines or use the mark alone.
     The mark is three rectangles and a tile. It has no font to miss. -->
<img alt="Pitwall" width="96" src="https://raw.githubusercontent.com/404sl/pitwall/master/ui/brand/logo/pitwall-mark.svg">

# Pitwall

One screen over every project you have work running in — what is blocked, what needs
a person, and whether that is still true.

[pitwall.build](https://pitwall.build) · AGPL-3.0

---

## The dashboard is not the point

Pitwall reads a project's tracker, its repositories and its lanes, and reports them
together. Most of what it prints is gathered. Two things are computed, and neither
exists in any source it reads:

**Classification** — why an issue is not simply "open", in the terms that matter to a
person. Only two states are somebody's own queue: a decision only they can make, and an
action only they can run. Everything else is parked, blocked, or being worked on by
something else.

Summing those together overstated a real backlog more than fourfold — 74 against an
actual 17 — so the split is defined once, in the contract, and never re-derived by a
consumer.

**Staleness** — whether the reason an issue stopped is still true. An issue records why
it was parked; nothing records when that reason expired. Four of six blockers surveyed by
hand were already dead: a title asking for a smoke test that had run nine days earlier, a
label describing access since granted, a decision already made.

A third rule follows from both: **a source that could not be read is never rendered as a
source with nothing in it.** Anything that fails to collect says so, per project and per
run. "Nothing to do" and "we could not look" are different answers and the screen has to
tell them apart.

## Status

Early, and honest about it. Working today:

```
pitwall snapshot     collect every project and print the snapshot as JSON
pitwall status       print the latest snapshot as one screen
pitwall doctor       check every source a snapshot reads and say what is wrong
pitwall serve        serve the console on http://127.0.0.1:7373/
```

`snapshot` discovers projects, reads their trackers, classifies every issue and reports
lane state. `status` renders that document as one terminal screen, reading the snapshot
the server reads or another file given with `--from`; both it and the console lead with the
snapshot's age rather than the time it was taken, and both call a snapshot stale once it is
ten minutes old, because a screen that reads as current when it is not is worse than no
screen. `doctor` prints one line per source
— the roots, each workspace file, the tracker, `bd`, `gh`, every repository and every lane
registry — with what was tried and what came back, and exits non-zero when a hard
requirement fails. `serve` serves that document over HTTP. **The console itself is still
being built** — until it lands, `serve` gives you the API and a placeholder page.

## Try it

```bash
npx @404sl/pitwall@latest snapshot
npx @404sl/pitwall@latest serve
```

`@latest` on every invocation, rather than a global install. `serve` is meant to be started
once and left running, and a copy installed globally is stale from the moment the next
release goes out. The console header names the version it is serving, and names the newer
one beside it whenever an hourly check of the registry has found one.

Projects are found by looking for `.pitwall.json` files, which describe a workspace: one
authoritative tracker, and the repositories under it. The older name `.autofix.json` is
still read, so a workspace that has not been renamed keeps working; where a directory has
both, `.pitwall.json` is the one in use. Run it from a directory whose children are
project workspaces, or configure the roots explicitly.

A `snapshot` run is appended to a local SQLite log at `~/.local/state/pitwall/history.db`
(`XDG_STATE_HOME` is honoured), at most one row an hour however often it runs. A tracker
holds current state and no time series, so the metrics that need more than one reading — the
median minutes from claim to close, how often claimed work goes back to open — are derived
from that log rather than stored in it. Each of them needs at least two recorded rows before
it says anything; until then the median and the bounce rate are absent rather than zero.

The log keeps the newest 500 snapshots and 30 days of them, and both bounds also bound the
answers, because the metrics can only be derived from rows the log still holds. The window
is 14 days or as far back as the log reaches, whichever is shorter, and the hourly floor is
what keeps those two in step: a fortnight at a row an hour is 336 rows, well inside the 500.
A console left open collects far faster than that — it re-collects on request against a
60-second floor, about 480 times in a working day — so without the floor one day at the
screen would evict the fortnight the median and the bounce rate are read over, and keep
rendering them over the last few hours. `history.maxSnapshots`, `history.maxAgeDays` and
`history.minIntervalMinutes` in `~/.config/pitwall/config.json` move all three bounds
together — a fortnight at ten-minute resolution needs a `minIntervalMinutes` of 10 and about
2000 snapshots, which at a couple of hundred kilobytes each is roughly half a gigabyte. The
default is sized to be safe on an unattended laptop, not to reach the finest resolution.

`landedToday` needs one reading, not two: it counts the issues closed today whose closure
names a merge, read from the tracker itself. Landed means merged, not deployed. Where the
tracker records no reason for a closure, or the tracker could not be read at all, the field
is absent rather than zero — nobody computed it is a different answer from nothing merged,
and the console says `unknown` for the first.

A log that cannot be written costs those metrics and nothing else: the snapshot still
arrives, and the failure is recorded in `errors`. `node:sqlite` arrived in Node 22.13, and
on an older Node there is no log at all — the metrics are simply absent, and nothing is
reported as an error, because a module a runtime never shipped is not a failed read.

## Completion notices

When an issue closes, the session that asked for it is the one that wants to hear. Pitwall
computes that notice from two consecutive snapshots — an issue that was open at the previous
collection and closed at this one — and delivers it by running a command you configure.
Until you configure one, notices are computed and nothing is sent.

First, `notify` in the workspace's `.pitwall.json`, an array of words whose first is the
program to run:

```json
{
  "idPrefix": "mw",
  "notify": ["script/notify-session.sh"]
}
```

A relative path resolves against the workspace root, and the array is handed to the program
directly rather than to a shell — write `["sh", "-c", "…"]` if you want one. The notice
arrives as one JSON object on standard input, never on the command line, because it carries
issue titles and a session ref and a command line is readable by anyone on the machine.
Exit 0 means delivered. Any other exit means it was not, and what the command wrote on
standard error becomes the recorded reason.

The object carries `issueId`, `title`, `origin` — the `session` that asked and the `ref`
that addresses it, which is the one to deliver to, because session names are neither unique
nor stable — `text`, the line to deliver, and `pull` only where a pull request was open for
the issue at the previous collection, as the snapshot records it. A notice is computed only
for an issue that records who asked, so a tracker whose issues carry no origin produces none
and nothing is appended to anything.

Second, `PITWALL_SESSION_REF` in the environment of the run, naming the session doing the
collecting. It is what stops a loop that creates, claims, lands and closes its own work from
interrupting itself once per pull request: a notice whose origin ref is this one is never
sent. A fixed single-session setup can name `sessionRef` in the workspace file instead, and
the environment wins where both are set — two sessions collecting the same workspace have
different refs and must not share a configured one.

Where that ref is unknown, every notice is held rather than sent, because with nothing to
compare against any of them might be the collecting session's own work coming back at it. A
notice that was not delivered — held, refused, or handed to a command that failed — is
appended to its own issue with the reason, so what did not arrive is readable afterwards
rather than lost. Silence is not one of the outcomes.

## How it is put together

```
@404sl/pitwall-schema    the snapshot contract — MIT, so an adapter for your own
                         tracker need not adopt copyleft
@404sl/pitwall           this — the agent and the local console, AGPL-3.0
```

The contract is a separate package on purpose. It is what a console renders, what a
server would validate on ingest, and what an adapter for a different tracker is written
against. It emits a JSON Schema artifact alongside its types, so a consumer that is not
TypeScript has something to validate against.

## Licence

AGPL-3.0. The contract package is MIT.
