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

The record and the screen are not the same thing. `errors[]` keeps every failure a reader
hit, and a consumer that wants all of them reads it there. The board shows the ones a
person can act on, because a band that is always full is a band nobody reads and a real
failure then arrives invisible. A consequence is counted against its cause rather than
listed beside it — 122 staleness checks that failed because one `gh` call was rate
limited are one problem, not 123. A failure that clears itself waits six hours before it
is anybody's. And a limitation every board carries on every run is documented rather than
reported: a tracker records why an issue stopped and not when, so a note written since
cannot always be placed, and nothing a person does will change that.

## Status

Early, and honest about it. Working today:

```
pitwall snapshot     collect every project and print the snapshot as JSON
pitwall status       print the latest snapshot as one screen
pitwall doctor       check every source a snapshot reads and say what is wrong
pitwall serve        serve the console on http://127.0.0.1:7373/
```

`snapshot` discovers projects, reads their trackers, classifies every issue and reports
lane state. It exits non-zero when every project it found failed, and when nobody said
where to look at all — no config and a fallback scan that found nothing — so a script can
tell a machine with no projects from a run that could not work out where to look without
reading `errors[]`. A config whose roots list is empty is an answer, and exits 0.
`status` renders that document as one terminal screen, reading the snapshot
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
In a workspace you have listed, notices are computed until you configure one and nothing is
sent; a workspace found by scanning is read and nothing more.

First, `notify` in the workspace's `.pitwall.json`, an array of words whose first is the
program to run, in a workspace you have listed yourself:

```json
{
  "idPrefix": "mw",
  "notify": ["script/notify-session.sh"]
}
```

`notify` is read only for a workspace named in `roots` in `~/.config/pitwall/config.json`.
Run Pitwall from a directory whose children are workspaces and it finds them by scanning
instead, which is enough to read a board and is not enough to run a program: a workspace file
is committed, so a repository you merely cloned could otherwise name a command that runs on
your machine at the next `snapshot`. For a workspace found by scanning, notices are not
computed at all and nothing is written to its tracker — collecting one stays a read. Where
such a workspace does name a `notify` command, that is said once per collection rather than
once per notice: `snapshot` writes a line to standard error naming the roots and the file to
list them in, and the console carries the same line as one row against that file, because it
is a fact about your configuration and not about any issue. `sessionRef` in a workspace file
is read on the same terms. `PITWALL_SESSION_REF` is not, because the environment of the run
is yours.

A relative path with a separator in it, like `script/notify-session.sh`, resolves against the
workspace root; a bare name with no separator is looked up on `PATH` like any other program.
The array is handed to the program directly rather than to a shell — write `["sh", "-c", "…"]`
if you want one. The notice arrives as one JSON object on standard input, never on the command
line, because it carries issue titles and a session ref and a command line is readable by
anyone on the machine. Exit 0 means delivered, so read standard input before exiting 0: a
command that exits 0 without reading is taken at its word. Any other exit means the notice was
not delivered, and what the command wrote on standard error becomes the recorded reason.

The object carries `kind`, which is `completion` for these, `issueId`, `title`, `origin` — the `session` that asked and the `ref`
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
compare against any of them might be the collecting session's own work coming back at it. In
a workspace you have listed, a notice that was not delivered — held, refused, or handed to a
command that failed — is appended to its own issue with the reason, so what did not arrive is
readable afterwards rather than lost. `snapshot` writes a line to standard error for each of
them as well, and
where the tracker refused the note too — the one case where the reason would otherwise be
written down nowhere — the notice is reported as an error on the board, beside everything
else the collection could not do. That row is carried by the snapshot the collection wrote and
by no later one, so it is the alert and the bead is the archive. Silence is not one of the
outcomes.

## When the collection itself stops

A board that cannot be collected says so on the screen, which reaches whoever is looking at
it. Nobody need be: re-collection failing every minute for eighteen hours is one event that
nobody sees until the morning, and the board it leaves behind is a day old and looks
current enough to trust. That is the one thing worth reaching somebody over, and the only
one — everything else the console knows belongs on the board.

`pitwall serve` counts how long re-collection has been failing without a break. Past fifteen
minutes it delivers one notice, and one more when the next collection succeeds: not one per
attempt, and never a stop with no resume, because a resume nobody hears trains people to
ignore both. Two notices an outage, whether it lasts sixteen minutes or eighteen hours.

They go through the same `notify` command a completion notice goes through — the first
workspace listed in `roots` that names one. A workspace found by scanning is never run, for
the reason above. `PITWALL_SESSION_REF` does not apply: an outage is nobody's own work coming
back at them, so a console with no session ref still says when the board has stopped moving.

The object carries `kind` — `collection-failed` or `collection-recovered`, against
`completion` for the notices above, so one command can tell the three apart without reading
the rest — `since`, the first failure of the run of them, `forMs`, how long it had been
failing when the notice was written, and `text`, the line to deliver. It carries no `origin`
and no `issueId`: an outage belongs to no issue and no session asked for it, so the command
decides who hears, and one written to read `origin` must check `kind` first.

Where there is nothing to deliver through, the notice is not dropped quietly: what it said
and why nobody was told becomes a row on the board against `pitwall serve: outbound notice`,
beside everything else the console could not do.

## Closing the issue a bead came from

An issue filed on a public repository becomes a tracker item carrying an external reference
back to it. Nothing in the tracker closes the public issue when that item closes, so a
repository keeps advertising work that shipped days ago. Pitwall closes it, from the same two
consecutive snapshots the notices are computed from: a bead that was open at the previous
collection and closed at this one.

The link is the bead's recorded external reference and nothing else. A title is not a link —
two unrelated items can carry the same one with no tell — so a bead that records no reference
closes nothing, however well its title matches. Only a `https://github.com/<owner>/<repo>/issues/<n>`
reference is acted on, and only where `<owner>/<repo>` is the origin of one of the workspace's
own checkouts: a reference to somebody else's tracker, or to a pull request, is read and left
alone.

What the comment may say is decided by the close reason alone, because that is the only thing
the tracker holds that records something having shipped. The reason has to OPEN by naming a
pull request or a revision — "Landed in cli #91", "Merged as 404sl/pitwall#94 (44cc687)" — and
the comment quotes its first sentence, no further than that reference and never more than 120
characters, so a remark meant for the tracker does not travel with it. Anything that opens some
other way leaves the issue open however it goes on: "Will not do — out of scope. Related work
landed in cli #77" reports nothing, because what shipped there is not what this bead did. So
does a reason whose reference arrives only in a later sentence, and so does no reason at all —
a pull request being open for that bead at the previous collection is not evidence that anything
merged, and is never read as any. A bead closed as superseded, a duplicate, won't-do or not
planned is not reported to its issue as shipped at all: what to do with somebody else's report
is a person's decision, and the issue is left open with a line saying so.

A number only becomes a link where two facts agree. `#91` in a comment on a public repository
addresses that repository, which is the wrong one as often as the right one, so an unqualified
number travels as literal text unless a pull request of that same bead carries that same
number — then the comment names the pull request in full. A reference that already names its
repository is left exactly as the reason wrote it.

One direction only. The one thing this asks GitHub to do is close an issue with a comment;
nothing reopens a bead, promotes anything into the tracker, or reads issue comments. It runs
for a workspace you have listed in `roots`, on the same terms as a notice, and a workspace
found by scanning closes nothing.

Whether a reference is one of ours is answered by asking each checkout for its `origin`, and a
checkout that will not answer is not the same as one that has nothing to say. A path that is no
repository, or a repository with no `origin`, simply owns no reference. A checkout whose `git
remote get-url origin` FAILS — a broken `.git`, an unreadable configuration, no `git` on the
path — cannot be distinguished from one that does not own the reference, so for as long as that
is true the run says so for every reference it could not place, naming the checkout and what git
said. Turning the feature off quietly is the one outcome that is not allowed.

A close that fails — no permission, no network, an issue since deleted — lands in three places:
standard error, the bead, and the problems the board shows, as an error against `gh issue close`
beside the project whose bead it was. It is not retried: the bead closes once, so the attempt
happens once, and what did not happen is readable on the bead rather than lost. The row belongs
to the snapshot that collection wrote and is gone from the next one, so the board is where
somebody notices and the bead is where it stays.

An issue deliberately LEFT open — nothing shipped, a veto, a checkout that would not answer —
is written to standard error with the reason and is not appended to the bead, because the bead's
own close reason already says what happened to it and the run is the thing that needs telling.

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
