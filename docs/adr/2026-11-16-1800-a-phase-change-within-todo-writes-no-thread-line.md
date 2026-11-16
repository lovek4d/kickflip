# A phase change within Todo writes no thread line; only requests do

The footer's phase word shows where a Todo card is, so a thread line that only reports the phase moving says it twice. A line stays when it records a request that caused the move.

Dropped (no longer written; the kinds still render in hub-lines.mjs for threads written before):

- `new-question`: a question added to a staged or ready card sends it back to grilling silently; the grey "N questions added" line stays.
- `prototype-round`: the board moving a grilling card to prototyping after the owner's yes.
- `discussing-start`: a new task, or a phase-less card, starting discussing.

Kept:

- `ready-expired`: the only place the owner sees why a ready card went back to staging for the server's recheck.
- `prototype-after`: records the owner's request for a prototype round (the card is still grilling).
- "Marked as staged", "Marked as ready", and the request lines (Prototype, Grill, Visual requested): taps and the orchestrator's words, not phase reports.

Lines are append only: existing lines stay. `migrateGates` still reads old `prototype-round` lines.
