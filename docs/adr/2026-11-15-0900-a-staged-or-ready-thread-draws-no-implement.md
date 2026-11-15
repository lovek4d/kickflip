# A staged or ready card's thread draws no Implement

A Todo card's thread draws Implement only while the card owes it. A staged or ready card has had its Implement, and a
bare Implement on it answers 409 (docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md),
so its thread box sends Reply alone (`app-threads.js` `laneSends`: `todo-staged`, `todo-ready`). This replaces the
builder-orange `button.build.ready` of docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md,
which no longer draws.
