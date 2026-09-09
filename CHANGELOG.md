# Changelog

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
