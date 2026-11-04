# Landing it lasts until the board listens

This changes [a new board shows its start steps and live clone progress](2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md), where "landing it" ran from the recorded session until the route joined, a span with no signal and a clock for a caption.

- **starting orchestrator** is one pulsing step, from the clone's end until the session joins. It shows no milestones and no sub-label, and `doctor` and `join` stamp nothing on the row: the owner decided fidelity there is not worth it.
- **landing it** runs from the join until the board server answers on its port and the board's watcher is listening (`isListening`). Its seconds count from the join.

`kickflip join` no longer deletes the route's Starting record; it adds `joined_at`. `startingBoards` shows a record whose route has a site only while it has `joined_at` and the board isn't yet listening with its server up, and the hub leaves that site out of the sidebar's boards meanwhile, so the board never appears twice. When both hold, the row is gone and the board shows with the join fade. The hub's 15-second tick (`settleStarts`) deletes the records of boards that have landed, or whose site is gone.

The 15-minute failure clock covers this step too. A joined board still not listening then reads "Its session joined, but the board is not listening yet." Its sheet offers Dismiss only, since a retry would start a second session over a live board; dismissing shows the board as it is. A session that stops to ask the owner something holds the row on "landing it" until it answers.
