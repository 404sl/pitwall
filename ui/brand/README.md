# Brand assets

**A copy. Do not edit these here.**

The source of truth is `brand/` in the internal documentation repository, currently
rev 02. These files live in this repository because a lane works inside one checkout
and cannot reach across to another - the console has to build against something that
is on its own master.

When a token changes at the source, it changes here in the same pass, and the
revision above moves with it.

## What the console must honour

Two of the rules in the source `README.md` are product rules, not styling, and a
reviewer may reject work over them:

- **Signal colours never decorate.** Green means something is genuinely running or
  genuinely merged; red means a lane needs a person. A board with forty lanes should
  be almost entirely grey. Parked, blocked and ready are NOT colour-coded states, and
  the staleness verdicts are not a traffic light. If the screen is colourful, the
  classification is wrong rather than the palette.
- **Lead with the number, name the lane.** "Lane 3 failed typecheck. 2 files.", never
  "Oops! Something went wrong."

Dark is the product surface and the default; light is for marketing and docs. On light
surfaces the signal colours drop to L=0.52, because 10-12px data type needs 4.5:1 and
the dark-surface values do not reach it.

All three faces are Google Fonts. **The console must stay legible offline** - self-host
them or declare a real fallback stack. It runs on a laptop that will not always have a
network, and a dashboard that loses its typography on a train has failed.
