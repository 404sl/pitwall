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
pitwall serve        serve the console on http://127.0.0.1:7373/
```

`snapshot` discovers projects, reads their trackers, classifies every issue and reports
lane state. `status` renders that document as one terminal screen, reading the snapshot
the server reads or another file given with `--from`. `serve` serves that document over
HTTP. **The console itself is still being
built** — until it lands, `serve` gives you the API and a placeholder page.

## Try it

```bash
npx @404sl/pitwall snapshot
```

Projects are found by looking for `.pitwall.json` files, which describe a workspace: one
authoritative tracker, and the repositories under it. The older name `.autofix.json` is
still read, so a workspace that has not been renamed keeps working; where a directory has
both, `.pitwall.json` is the one in use. Run it from a directory whose children are
project workspaces, or configure the roots explicitly.

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
