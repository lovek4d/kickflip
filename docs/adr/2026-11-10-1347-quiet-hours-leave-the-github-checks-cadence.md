# Quiet hours leave the GitHub check's cadence

[Boards read PR state from the hub's check](2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md) made quiet hours count as away for the hub's GitHub check, and coming back in them wait for the next check. This supersedes that bullet, "Quiet hours count as away", in part. The owner on #506: "How about we just drop quiet hours for this mechanism, and simplify to here and away only?"

- **The check follows presence alone.** Every minute while the owner is present, every 5 while away, at any hour (`hub/schedule.mjs` `nextCheckAt` loses `quiet`; `hub/hub.mjs` `nextPollAt` and `presenceChanged` no longer read quiet hours). Coming back checks at once at any hour. The owner on #506: present overnight means every minute again.
- **Overnight polling is 5 minutes while the owner is away**, which they are overnight, so #457's ask still holds.
- **Unchanged.** The low-budget slowdown (5 present, 15 away), the push hold, the daily wake at quiet hours' end and the overnight triage read quiet hours on their own. The Quiet hours hint, "checks every minute while you're here, every 5 when away", is true again.
