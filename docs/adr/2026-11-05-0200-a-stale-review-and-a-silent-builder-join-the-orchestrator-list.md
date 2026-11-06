# A stale review and a silent builder join the orchestrator's list

Amended by [stale is automatic, stalled is the orchestrator's flag](2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md): the `stalled` kind is now `stale`, a stale review stays In Review rather than in a Stale lane, there is no `builder-nudge`, and the orchestrator flags a card it can't restart with `item stall`.

The owner, on #206: "if a card is decided to be stale, I would like to automatically nudge the orchestrator to take a look." A builder reading Stalled woke the session once per silent spell (`builder-stalled`), and a review gone Stale woke nothing: the Stale lane showed it and no push or event followed.

- **Two more kinds on the list** ([each lane is a queue for the orchestrator](2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md)). `domain.mjs` `orchestratorWaitOf` adds `stalled`, a builder or planner past the stall limit ([a builder stalls after 10 minutes without movement](2026-11-05-0001-a-builder-stalls-after-10-minutes-without-movement.md)), waiting since its `silentSince`; and `stale`, a card in the Stale lane, waiting since it crossed seven days in review. Both ride the existing `orchestrator-waits {added}` event, the list the watcher prints on every wake and the 30-minute push to the owner.
- **Once per stale spell.** An entry is new when its card, kind or since differs, so a spell wakes once, across a restart, and the next silent spell or a card back in Stale wakes again. A wake missed or left unhandled comes back on the next wake of any kind, which is why nothing re-sends.
- **`builder-stalled` is gone.** `checkStalled` and `data/builder-stalled.json` are removed; the list covers what they did. The owner's Stalled button still sends `builder-nudge`.
- **What the orchestrator does with a stale review:** find out why (CI red, a conflict, changes requested, reviewers silent), fix what it can (rebase, fix CI, answer comments), re-ping silent reviewers once in Slack, write one thread line, and ask the owner only when a decision is needed (close it, change reviewers).

Considered: a separate event and state file for the stale review, like `builder-stalled`. It duplicates the walk and the once-per-spell bookkeeping the list already does.
