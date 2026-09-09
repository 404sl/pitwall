# Writing a ticket

A ticket is read by two people who want different things: somebody deciding whether to care,
and a run that has to do it. Neither wants the story of how it was found.

## The shape

```
line 1        WHAT TO DO, as an instruction
traps         each one a specific wrong action it prevents
evidence      a link - issue, replay, measurement. Do not restate it
acceptance    what "done" means, checkable
```

Nothing else. If a paragraph does not prevent a wrong action or say what done means, it
belongs in the linked source or nowhere.

## What earns its length

Only three things, and each is worth many paragraphs:

- **A trap.** "Do not edit the seed migrations - they are already applied, editing them changes
  nothing in any environment that has run them, and produces a green diff that leaves
  production exactly as it is." That sentence stopped a wrong fix.
- **A fact that cost somebody time.** "The column is `key`, not `name`" - a check against
  `name` returns nothing and reads as an all-clear on rows that are certainly there.
- **A constraint that would otherwise be re-litigated.** "Do not reimplement this check; a
  boolean return would destroy the ran/fired distinction."

## What does not

- The narrative of discovery. How it was found is not how it is fixed.
- Reasoning already written in the linked issue, replay or measurement. Link it. A summary is
  a second version that drifts from the first.
- Restating the acceptance criteria in prose above the acceptance criteria.

## Measured cost of getting this wrong

- A ticket closed having met every criterion but one, which was buried in a long body. The
  same reporter filed the same complaint twice.
- A ticket sat finished-but-unshipped for a day because a brief was long enough to contain a
  contradiction with the test suite.
- A reader opened a ticket and could not tell what was wanted from them. That was a console
  bug, but the console was rendering what the ticket said.

## Two tickets, not one

If a ticket has two halves that fix independently, file two. A run will do the tractable half
and the other half's acceptance goes quietly unmet - that has happened here twice.

## When there is a source of truth elsewhere

Say so and stop:

> Reported and fully described at <link> - read it first. The issue carries the evidence, the
> measurements and the reasoning. This ticket is the work item; the issue is the source of
> truth and should not be summarised away here.

Those tickets run about 1,500 characters and lose nothing.
