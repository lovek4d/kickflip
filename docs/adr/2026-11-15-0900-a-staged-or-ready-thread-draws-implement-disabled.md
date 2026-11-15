# A staged or ready card's thread draws Implement disabled and quiet

A Todo card's thread draws Implement enabled only while the card owes it. A staged or ready card has had its Implement,
and a bare Implement on it answers 409 (docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md),
so its Implement is drawn disabled and quiet (`app-threads.js` `laneSends`: `todo-staged`, `todo-ready`): not orange,
not tappable. This replaces the builder-orange `button.build.ready` of docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md,
which no longer draws.

Superseded step: the first version of this decision (T-414) hid the button on a staged or ready card. The owner
objected: "I meant implement shouldn’t be orange when staged. Not that the button should go away. Maybe instead let’s
make it disabled and quiet". Hidden became disabled (#776); the server's 409 stays.
