# devloop

Works a project's backlog without a person in the loop: picks eligible open issues by
priority, fixes each in its own git worktree, reviews the result adversarially, and gets a
green pull request. A separate serial lander rebases, merges, deploys and closes.

**It merges to the default branch on its own, and deploys any repository configured to
deploy.** That is the point of it, and it is the reason for the design gate, the adversarial
review and the label handoff. Do not loosen those to make a run go faster.

## Install

```
/plugin marketplace add 404sl/pitwall
/plugin install devloop@pitwall
```

## Set up a project

The plugin is the machinery; a project needs a tracker and a configuration file before any of
it does anything. That setup is one document:

    https://pitwall.build/agents/onboard.md

It covers both shapes - a single repository, and several repositories under one tracker.

## What you also need

- **`bd`** ([beads](https://github.com/gastownhall/beads)) for the tracker.
- **`gh`**, authenticated, with push rights on the repositories involved.
- **`python3`**, used by the queue and configuration readers.

## Shape

A **supervisor loop** in the session, **one background workflow per issue**, and **one serial
lander**. The loop owns concurrency; a task workflow only knows how to finish one thing
properly, so a crashed workflow costs one issue rather than the run.

The handoff between the two halves is a GitHub label. A lane gets its pull request green,
checks the body and commits for compliance, adds `lane-verified`, and stops. The lander reads
that label and nothing else - tracker status was wrong often enough that the two were
deliberately untangled.

## A note on the comments

Much of this code is comment, and most of those comments record a specific failure rather
than explaining syntax. They are the point: each one is a run that went wrong once and the
reason the code now looks unusual. Rewriting one to be shorter generally means removing the
only record of why the obvious version does not work.

## Licence

AGPL-3.0, with the rest of Pitwall.
