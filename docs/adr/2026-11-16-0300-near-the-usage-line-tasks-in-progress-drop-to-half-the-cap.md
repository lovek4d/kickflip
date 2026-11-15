# Near the usage line, tasks in progress drop to half the cap, rounded up

Near the line (within twice the buffer of it, from 80% for the 90% line) the board server used to start one agent, then the next only once the newest run had reported its usage, ten minutes at most. That was a stagger, not a cap: the cap already counted cards In Progress ([the implementer limit counts cards In Progress](2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md)). The owner asked for the cap itself to fall.

- **Half the cap.** Near the line the pull's cap is `ceil(cap / 2)` (5→3, 4→2, 6→3, 1→1): `tasksInProgressCap` in `shared/usage-gate.mjs`, read by the pull and by the Implement tap's full check. Cards already In Progress above the reduced cap keep running; only new pulls wait.
- **Keep going near the line** (`keepGoing {window, until, near: true}`) restores the full cap until that window's reset, as it lifted the stagger. It never lifts the pause at the line.
- **The stagger is gone.** `near` is `{window, used, resets_at, from, going}`: no `waiting`, no `launchHeld` (every launch check is `heldFor`), no wait on the newest run's first reading, so `hub/usage.mjs` no longer reports a `start`.
- **Names.** The setting reads "Maximum tasks in progress" everywhere it shows (it counts cards In Progress, not agents). The CLI key `max-implementers` and board.json `max_implementers` stay: renaming them would need a migration for no change in what an owner reads.
- **Banner.** The Hub page reads "Approaching usage limit, reducing parallel tasks in progress" with Keep going; once kept, "Approaching usage limit: tasks in progress back to the full cap until <time>" with Stop.

Supersedes the Near the line paragraph, the "only the board server waits" paragraph and the Banner paragraph of [the pause line reads every headless agent's usage](2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md).
