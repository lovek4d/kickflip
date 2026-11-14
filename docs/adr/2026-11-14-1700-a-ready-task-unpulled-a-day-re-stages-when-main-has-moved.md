# A ready task unpulled for a day re-stages when main has moved since its ready

A ready card's notes were checked against main when it was readied. One that sits unpulled (held, blocked, or with no free slot) can go stale if main moves meanwhile.

- A Todo card readied records `ready_at` (`item set --phase ready`) and, within a minute, `ready_main`, the base branch's commit then (the server's `checkReadyExpiry`, `restageStaleReady` in `board/store.mjs`). A card ready before the record is stamped on first sight.
- Each minute, a card ready for `READY_EXPIRES_MS` (24 hours, a constant) whose base branch's commit differs from its `ready_main` goes back to staging: a "Ready expired after a day unpulled: re-checking against what landed since" line, its notes kept. Staging is the orchestrator's usual wait, so it re-checks the notes against main and readies the card again or reshapes it. Each ready restarts the clock.
- If main has not moved, the card stays ready however long it waits: its notes can't be stale.
- Held and blocked cards expire alike. A card blocked by tasks still in progress is not exempt (owner, 11/14: the dependency has nothing to do with whether main moved).
