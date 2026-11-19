# A bumped card's serve goes first too

Status: accepted (card #1107, T-778, found verifying T-754)

Amends [every hub limit takes the same turns](2026-11-19-0800-every-hub-limit-takes-the-same-turns.md), whose
Consequences said the hub knows no bumps for serves, and so broke
[a bump goes first in every queue](2026-11-19-0242-a-bump-goes-first-in-every-queue.md) for serves.

## Decision

- Auto serve's tick reads each waiting serve's standing bump with `landFirst` (`board/runs.mjs`), the same read the land
  queue makes, and puts it in the waiter's `first`. `inTurns` then takes bumped serves first, the earliest bump first
  whichever board it is on, before the boards' turns.
- A bump still moves no turn and never stops a serve that is running.
