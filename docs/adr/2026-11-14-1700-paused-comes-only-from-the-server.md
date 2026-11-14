# Paused comes only from the server

The browser no longer reads the hub's usage pause to guess "paused" on a mark. Since the usage-gate hook lets the
orchestrator keep sorting, readying, screening and answering under every pause, an ask the orchestrator works on, a
message's working footer and the orchestrator-review line never read paused: they read their working words.

"paused" appears only where the server says something is held. A builder reads it from `builder.pause`. A card whose
planner waits in `data/queued-planners.json` for a launch hold carries `plannerQueued` (domain.mjs), and its alert row
ends with a grey bold "paused", with no phase words. The sidebar, header and banner pause words read the hub's own state
and stay. The wider audit of browser guesses is T-322.
