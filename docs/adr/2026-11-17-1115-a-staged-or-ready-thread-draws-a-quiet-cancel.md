# A staged or ready thread draws a quiet Cancel in Implement's place

Supersedes docs/adr/2026-11-15-0900-a-staged-or-ready-thread-draws-implement-disabled.md.

Once Implement is tapped and the card is staged or ready, the thread's second button is no longer a disabled
Implement but a quiet "Cancel", drawn like Block (`app-threads.js` `sends`, `todo-staged` and `todo-ready`). It acts at
once with no confirm and sends `card-cancel {key}`. The server applies it as it does a Reopen
(`store.mjs` `recordOwnerTap`): the card goes back to Todo, discussing, with its staging and ready marks cleared, its
Implement owed again and a ready card's ticket kept, and the thread gets one line, "Cancelled Implement". One on a card
that is not staged or ready is a 400 and records nothing. `card-cancel` wakes no session: leaving staging clears the
orchestrator's "judge the staged task" wait, and a card no longer ready is not pulled.

A Cancel that races the pull carries the card's version, so the server's 409 refuses it once the builder has started;
the card is then In Progress, where the second button is Block. The request row (Prototype, Grill, Visual) stays
disabled until Cancel. Cancel does not undo what Implement already did: its planners stay stopped and any Implement
words stay in the notes.

The owner asked for it: "Implement instead of becoming disabled should become a quiet “Cancel” button or something similar".

Cancel draws at the tap, not when the board answers: a Todo card whose Implement sits in the outbox, not failed, reads
staged (`ui-snapshot.js` `tapped`), so a second tap cannot send Implement again, and a failed send brings Implement
back. The server also answers a bare Implement on a staged card 409, as it does on a ready one, so a double tap from
two pages cannot stage twice.
