# A written brief wakes the board, and going discussing drops owed briefs

Card #568. `item brief` wrote the card's briefs entry and notes but appended no event, so the board's auto pass (`runAuto` → `launchBriefs`) ran only when something else woke it: a prototype brief on T-171 waited six minutes. The owner also saw no "Prototype requested" line, which their own tap writes.

- **`item brief` appends `brief-written {key, kind}`**, a record-only event (`bin/event-lines.mjs` RECORD_ONLY, as the orchestrator wrote it), so the auto pass launches the planner on its next run.
- **The thread gets "<Kind> requested" from the orchestrator** (a command line, as `COMMANDS` words it) unless the entry the brief answers carries the owner's ask: a tap wrote that line already. A brief for an arrival's owed entry has no ask, so it gets the line.
- **A card set to discussing drops its unwritten briefs** (`item set --phase discussing`, the orchestrator's reply). Filing a held card, then unholding it and setting it discussing as two calls, left an arrival's grill entry owed that nothing cleared, reading "preheating" and holding a planner slot in `arrivalsOf`. Written briefs stay for their launch.
- **`item add --phase discussing`** already files a card straight to discussing; no change.
