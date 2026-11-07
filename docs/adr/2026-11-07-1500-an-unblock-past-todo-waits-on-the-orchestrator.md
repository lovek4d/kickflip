# An unblock past Todo waits on the orchestrator

Card #405. #385 (the 0.6.0 release) waited on #398 in its Next text alone. #398 landed with no calls to verify, so nothing reached the orchestrator and the owner had to ask. Owner's answers on the card (11/07): an unblock past Todo that nothing picks up wakes the orchestrator as a wait that re-wakes; an In Progress card stays there when blocked; `item set --next` catches a `#N` too; no prototype round. The audit of the current waits is #425, and the shared card pause for blocked, held and usage-limited cards (a running builder pausing at its next stopping point) is #432. This card does the no-builder case only.

It supersedes "Wakes are untouched" in [a block past Todo bumps a build and holds a land](2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md) and amends [only typed thread messages wake the orchestrator](2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md): `card-unblocked` stays record-only, and the wake moves to a wait.

## Decision

- **An unblock past Todo is a wait.** When a block ends on a card past Todo (the last dep finishes, or `--blocked-until ""`), the card stores `unblocked_at`, the ts of its "Unblocked:" thread line. `orchestratorWaitOf` reads it as an `unblocked` wait, in In Progress with no builder running and in In Review. It re-wakes on the usual cadence ([nothing waiting on the orchestrator is missed](2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md)) and ends when the session writes a thread line on the card after the unblock, when a builder runs, or when the card is blocked again or closes. An unblock in Todo stays record-only: the pull takes the card.
- **A finishing dep unblocks a card in any open lane.** `unblockedBy` skipped every card whose stored lane was past Todo, which, since a card stores its lane, left a card In Review without its "Unblocked" line or event. It skips only closed cards.
- **A block leaves a card with no build running where it is.** Blocking a card In Progress sends it back to Todo only when a board-launched build runs, which is stopped. A handed-back or reopened card stays In Progress with its hand-back, and its thread reads "Blocked …: it stays In Progress."
- **A Next that names an unfinished card by its `#number` is refused** without `--deps`, as one naming its id already was.

## Not done

- A running builder is still stopped and sent back to Todo; pausing it at its next stopping point is #432.
- A hold's pick-up time marks no `unblocked_at`; holds are #432's.
