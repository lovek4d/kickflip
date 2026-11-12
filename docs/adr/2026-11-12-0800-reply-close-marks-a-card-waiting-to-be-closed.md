# `--close` marks a card waiting to be closed

The owner (card #575, from T-153) wanted a card that only waits for their confirmation to close to say so: Done goes orange and the card reads Action needed. T-153 is the case: a chore only the owner can do (update the Slack app, paste its token) once the orchestrator has nothing left.

- **One mark, two values.** T-174's `implement_ready` becomes `waits_on_owner {on: implement | close, at}` on the card's item file entry; the card carries it as `ownerWait`. `reply <card> --implement` sets `implement`, `reply <card> --close` or `thread <card> --close` sets `close`. Nothing reads it from the message text.
- **What it shows.** A close mark is the action `close` ("Tap Done"), whose resolving button is the thread's Done (`BUTTON.done`, drawn orange as `closes`). A Todo card stays in Todo, where its Close goes orange; any other card is in In Review, where Done is. The link opens the thread with the reply box focused.
- **What clears it.** The owner's Done tap and any message of theirs on the card, as the implement mark clears on Implement or a message. A Done card shows no action.
- **An exception to** [a card waiting only to be closed has no Action needed](2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md): that holds for a card the board finds waiting on Done (`awaitsDone`) from its state. A card the orchestrator marks has been judged to need the owner's confirmation, so it is Action needed.
- It counts in the need-you badge like any Action needed.
