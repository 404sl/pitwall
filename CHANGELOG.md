# Changelog

## 0.1.2

**The published package did nothing at all.** Both 0.1.0 and 0.1.1, installed or run through
npx, produced no output and exited 0.

The CLI decided whether it had been run or imported by comparing the *basename* of `argv[1]`
against its own module URL. That is true when you run `node dist/cli.js` and false for every
installed copy, because npm links the binary as `pitwall` while the module is still `cli.js`.
The guard failed, nothing ran, and the process exited successfully.

It survived because every test invoked the file by its own name - the one way it worked. There
is now a test that runs it through a symlink under a different name, verified to fail on the
old guard.

`--version` also reported 0.1.0 from 0.1.1: `src/version.ts` is hand-maintained because the
compiled CLI ships without its manifest, and nothing kept it in step. A test now asserts it
matches `package.json`.


## 0.1.1

- `pitwall doctor` now fails its root check when `root` is not a path, instead of
  reporting a configuration it cannot actually resolve as healthy.

## 0.1.0

First published version. `pitwall snapshot` reads a project's tracker, its repositories
and its lanes and emits one document against the snapshot contract; `pitwall serve` renders
it as a board.

The two computed fields are the point, and neither exists in any source it reads:

- **classification** - why an issue is not simply open, in the terms that matter to a
  person. Only two states are somebody's own queue: a decision only they can make, and an
  action only they can run.
- **staleness** - whether the reason an issue stopped is still true. An issue records why
  it was parked; nothing records when that reason expired.
