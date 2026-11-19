# Threads say Reply, with Hold, Resume and Reopen beside it

Superseded in part by [the owner's hold is a block](2026-11-15-2230-the-owners-hold-is-a-block.md): Hold and Resume read Block and Unblock. Reopen moves a Done card to In Review, and a message on a Done card leaves it Done ([a Done card stays Done when commented](2026-11-18-2359-a-done-card-stays-done-when-commented-and-only-reopen-moves-it-back.md)).

The owner (card #588): "Align the in progress thread with the to-do and in review by adding a second button … And do the same thing for done. We should have a reopen and a reply. So we shouldn't have send buttons anymore, really. They should all say reply and they should all have the same style. Reopen and pause should both be quiet buttons, but resume can be orange." In the grill, Pause turned out to be the card's Hold under another name, and the owner took "bring hold over to in progress".

**Every thread box has Reply, and a second button beside it.** Reply (⌘↵, `intent: 'reply'`) is the box's primary send in every lane, orange while it clears the card's Action needed; no thread box says Send. The second button, on ⌥↵, sits before it as Todo's Implement and In Review's Done already did (app-threads.js `sends`):

- **In Progress**: **Hold**, quiet, the same tap as the action row's: it opens the Hold sheet and sends `card-hold`, which pauses the build at its next stopping point ([a card pause stops its builder at its next stopping point](2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md)). While the owner's hold is on, **Resume**, orange (`unhold`), confirms and sends the unhold, which resumes the builder's own session. A usage or block pause still shows Hold: Resume lifts only the owner's hold. The action row's Hold or Unhold stays.
- **Done**: **Reopen**, quiet, confirms and sends `card-reopen {key}`.

**An In Progress card reads held.** The board used to show held only on a Todo card, so an In Progress card the owner held read unheld, and the board's pause pass dropped or resumed its "held" pause at once. `workItem` now reads the owner's hold on a Todo or In Progress card; In Review and Done never read held.

**Reopen moves a Done card back to Todo, discussing.** The board server writes it before its event, as it does a Done (`store.mjs` `recordOwnerTap`): a "Reopened" status line, then the move to Todo with phase discussing, with `reopened_at`, and the thread line "Moved to Todo: you reopened it". It wakes nobody (`bin/event-lines.mjs` `RECORD_ONLY`): the card's discussion picks up from the owner's next Reply. A card not in Done is refused with a 400 and records nothing. On the board a card stored in Todo with `reopened_at` reads Todo until a build takes it, its merged PR or not, and still counts as finished for the cards waiting on it, as a reopened card did.

**A Reply on a Done card keeps today's meaning**: it reopens the card to In Review, waiting on the orchestrator ([a message or question on a Done card reopens it](2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md)). Reopen is the owner's way back to the conversation, and amends that ADR and [a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md) for the tap.

Out of scope: the questions page's Send, the New task sheet, prompts and the progress review's Send, and the shortcuts sheet's "Send ⌘↵" row, which names every composer's first key: none of them is a thread reply.

Amends [Done shows only in In Review, beside Reply](2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md) (In Progress's lone Send) and [each text box sends its intent from a key](2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md) (a one-button box carries no intent: every box's Reply now carries `reply`).

Considered: a new Pause word over the same tap, which would blur the usage-limit "paused" with the owner's hold; Reopen to In Review waiting on the orchestrator, like a Reply's reopen, which the orchestrator passed over for T-152's discussing phase.
