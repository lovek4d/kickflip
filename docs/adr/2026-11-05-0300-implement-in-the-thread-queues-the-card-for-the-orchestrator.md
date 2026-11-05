---
status: superseded in part by 2026-11-05-0802-todo-has-no-queue
---

# Implement in the thread queues the card for the orchestrator

Superseded in part by [Todo has no queue](2026-11-05-0802-todo-has-no-queue.md): ready has the board server start the card's build at once, past the cap, or bumps it while a dep blocks it; no message or status line reads "queued".

The owner, on #264 (a follow-up from #256): "more data for the incoming messages to clearly state intention deterministically, wondering if we can apply this information more later on". Settled in the grill and round 2 of the intent-lanes prototype:
- gh264-lanes C: only a Todo card's thread has two buttons. "reply and build (or just implement rather) replaces the existing implement button on todo cards".
- gh264-lanes-r2 A: the second button reads Implement. "implement should only be orange when flagged ready, else quiet".
- gh264-show A: a thread message shows which button sent it, as a muted footer.
- gh264-code A: code moves the card, and the session folds the words in. "it should go into queued until the orchestrator updates the notes/brief info, that way we can strictly kick off builders automatically on landing in in progress".
- gh264-answers A: no "Answer and build" on a question's note, since a card already builds once answered.

This replaces #256's Reply and build ([each text box sends its intent from a key](2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md)): the label, its "build requested" footer, and the session marking the card ready and starting the build itself.

- **Implement lives in the thread box.** A Todo card's box sends with Reply (⌘↵, `intent: 'reply'`) and Implement (⌥↵, `intent: 'build'`). Implement is builder orange (`button.build.ready`) once the card is ready, quiet before, following each board load (`app-threads.js` `sendsOf`). The card's action row has no Implement, and a held card shows Unhold. Other lanes keep one Send, which carries no intent. A wave band keeps its next card's Implement, which still sends `card-build`.
- **Every message footers its button.** Reply reads "Reply"; Implement reads "Implement", and "Implement · queued" while its card waits on the orchestrator from that message on (`domain.mjs` `threadOf` `implementAt`). An Implement with an empty box is a request line. A Send carries no intent and has no footer.
- **An empty Implement on a ready card is the old tap.** The board server starts the build as `card-build` does (`startTappedBuild`), with no event.
- **Any other Implement queues the card for the orchestrator.** The board server writes `implement_at` on the card's wave entry before it appends the message (`store.mjs` `askImplement`), resuming a held card as the Build tap does; a second Implement while it waits keeps the first time. The card is In Progress (`started`), owes no Next, is neither pulled nor grilled, and is on the orchestrator's list as `implement` ("Fold the Implement message into the notes, then item set --state ready to start the build"); its status line reads "queued · waiting for orchestrator". The watcher prints "Implement asked on <card>: fold the message into its notes, then item set --state ready starts the build".
- **Ready releases it.** `item set --state ready` on such a card moves `implement_at` to `queued_at`, so the board server starts it from the queue as it starts any tapped build (`checkAuto`, `startQueuedBuild`); the session never starts that build itself. A build start or a close clears `implement_at` too.

Considered:
- the session marking the card ready and starting the build (#256): the owner wants the card queued first, with the builder starting from code once the notes are current;
- a second button in In Progress, In Review and Done (gh264-lanes A and B): the owner kept one Send outside Todo;
- "Reply and build" as the label (gh264-lanes-r2 B): the owner picked Implement.
