# The + makes a New card, which Claude files, folds or answers

The board's + makes a card from the owner's first message, so the board has one kind of thing on it. The card is marked **New** until Claude sorts it, and there is no Waiting for Claude strip. The message is still stored as an `ask` event, and its thread keeps the key `ask:<event id>`; only what the owner reads says "new task".

- **Where a New card waits.** At the top of Todo, with no wave, above the Todo work cards: bumped New cards first, the latest bump on top, then the rest oldest first, so the top one is the next taken. It shows the message's first line as its title, a "New" chip, when it was sent and "Waiting" or "Working on it", and the bump, edit and delete icons of [0014](0014-a-pending-ask-can-be-deleted-or-bumped.md). It waits on Claude, so it has no Action needed badge ([0045](0045-the-lane-follows-who-acts-next.md)).
- **File it under a wave.** Claude names a work item for the change (`board.mjs item add`) and runs `item set <key> --from-ask <eventId>`. The New card gives way to the work card, whose thread opens with the message, its attachments and anything already said in its thread.
- **Fold it into the card it's about.** `board.mjs item relate-ask <eventId> <key> --summary <line>` moves the message, with its thread, into that card's thread at the time it was sent, marked "Moved", followed by the summary line. The New card disappears. Folding it again into another card moves it there, and `item set --from-ask` takes it out to a card of its own. When the owner says Claude picked the wrong card, `board.mjs ask unfold <eventId>` moves it back out to a New card of its own.
- **Answer it.** `board.mjs reply <eventId>` or a line in its thread moves the card to Done, where it reads "Task", folds under Done's Answered row, and keeps its thread for the owner's replies, as [0016](0016-every-ask-is-a-card.md) and [0035](0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md) describe.
- **Old links.** A link to `#item=ask:<event id>` of a message now in a work card's thread opens that card (`moved` in `GET /api/board`).
- **Sessions.** The owning session sorts New cards itself. A long build or investigation goes to a builder of its own, which reports back in the card's thread, as builders already do.
- **Opening the + dialog.** Pressing n twice opens it, except while typing in a field; the + button's tooltip says so.

The strip kept the owner's requests apart from the work, and a request that became work left an Ask card in Done beside its work card. The owner wanted one kind of thing on the board, with a request about an existing card landing in that card's thread rather than as a card of its own.

The owner settled this on the `hub-orchestrator` card INT-98: questions `nt-shape` (a card from the first message), `nt-fold` (fold it into that card), `nt-wave` (top of Todo, no wave yet) and `nt-session` (one session; long cards get their own), and asked for the double n.

Considered:
- keeping the strip and always making a card once Claude looked at it (`nt-shape`);
- keeping a request about an existing card as its own card, linked to it (`nt-fold`);
- picking the wave in the + dialog (`nt-wave`);
- each card's thread as its own chat session (`nt-session`).

This supersedes [0016](0016-every-ask-is-a-card.md) on where an ask waits and how it joins work; its Done items, threads and answer banner still hold. It moves the strip ordering of [0014](0014-a-pending-ask-can-be-deleted-or-bumped.md) to the New cards.
