# `reply --implement` marks a card ready to implement

The owner (card #564) wanted a card whose discussion ends at "tap Implement" to say so: the thread's Implement goes orange and the card reads Action needed.

- **The mark is the flag, not the words.** `reply <card> --implement` posts the message and stores `implement_ready {at}` on the card's item file entry. Nothing reads it from the message text.
- **What it shows.** The card carries Action needed ("Tap Implement") and stays in Todo, as a card with open questions does. The link opens the card and its thread and focuses the reply box at the bottom (`#selectedCard=<key>&reply`). The thread's Implement button is the action's resolving button (`BUTTON.implement`), so it draws orange.
- **What clears it.** The owner's Implement tap (`stageImplement`, bare or with words) and any other message of theirs on the card, which reopens the discussion.
- It counts in the need-you badge like any Action needed.

Considered: a card toggle letting the orchestrator file Quick builds itself (a separate card).
