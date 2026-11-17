# report timing splits a task's life by who it waited on

#929. The owner asked for better tracking of task timing, "although it should just be free with the timestamps etc we already store". The grill settled a CLI first (a page later is its own task), four waits, and both a per-task view and a per-day summary.

## Decision

- **`board.mjs report timing [<file>/<id>] [--since <date>]`** (`board/timing.mjs`), read-only, with no new fields or files. It reads the item files, the done archive, each task's thread, `events.jsonl` and `owner.json`'s questions.
- **A task's life, from `created` to `closed_at` (or now while open), is cut at each moment that changes who it waits on, and each piece gets one label.** A builder's or planner's run wins over a hold or block, which wins over whose turn it is. The pieces add up to the whole life, so the time nobody owed a step shows as **idle** rather than being dropped.
- **Whose turn it is:**
  - **On you** from the orchestrator's plain message or a `questions-added`/`new-question` line.
  - **On the orchestrator** from the owner's thread line or tap, an item event (`item-message`, `mark-ready` and the rest of `ITEM_EVENTS`), `card-done`, an `owner-answer` to one of the task's questions, or an `orchestrator-waits` event naming it. It lasts until the orchestrator's next write: a command line or `builder-told` ends it as idle, and a message hands it to the owner.
  - **Queued** from `readied` to the next run's start. A run's start also ends an orchestrator turn.
- **Runs come from the thread's `kind: status` lines, not `agents/`,** which keeps only each task's latest run. A line with a `run` spans from the run's start to its last line, and `planner: true` marks a planner's run. Lines without a run, such as a land's, form one span while each comes within 10 minutes of the last. That is the cadence builders report at.
- **Holds and blocks:** `card-hold`, the `hold`/`resume` commands and the `paused`/`resumed` lines bound a hold. A `blocked-by` line starts a block and `card-unblocked` ends it.
- **The summary counts the tasks closed on each local day, split between tasks with a builder run and those with only a planner or none.** For each group it gives the median and the slowest quarter's edge (the 75th percentile) of each of the four waits: on you, on the orchestrator, on a builder or planner, and held or queued (held, blocked and queued together).

## Considered

- **Orchestrator time from `waits-history` events.** They give an exact since and cleared, but only since 11/16 ([orchestrator waits keep a history](2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md)). The thread rule times every task the same way, back to its first line.
- **Waiting versus working inside a run.** Nothing stored tells them apart, so a run is one span.
- **A board or hub page.** It comes later, as its own task, over the same `timing.mjs`.
