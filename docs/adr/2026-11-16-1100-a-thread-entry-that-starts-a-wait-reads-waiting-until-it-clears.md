# A thread entry that starts a wait reads waiting… until it clears

An owner's message already read sending…, waiting…, thinking… in its footer from its own state (`threadOf`). A tap's
status line, such as "Marked as staged", had no state, so the card's header said it waited on the orchestrator while the
line itself read nothing.

The board has one definition of what waits on the orchestrator: each card's open waits (`orchestratorWaitsOf`), each with
the `since` of the entry that began it and `picked`. After the waits are built, `markWaitStarts` gives the tap line
whose `ts` is exactly a wait's `since` (`store.mjs` `stage` stamps the line and `staged_at` with one moment) the state `waiting`, or
`working` once picked. The footer draws it with the same `PICK_UP` table as a reply. The state is derived on every build,
so it clears with the wait. Lines that start no wait carry no state and read nothing.
