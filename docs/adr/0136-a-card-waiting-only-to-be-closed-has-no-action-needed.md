# A card waiting only to be closed has no Action needed

A reopened card that Claude has answered ([0128](0128-a-message-or-question-on-a-done-card-reopens-it.md)) waits only on the owner's Done. It isn't Action needed; it is just waiting to be closed out.

- **No action.** `board/domain.mjs` gives it no `action`: no Action needed badge, no Needs you line, no action push. It is flagged `awaitsDone`.
- **Lane and next.** It stays in In Review, since the owner acts next, with its next step "Tap Done once it is settled" ([0045](0045-the-lane-follows-who-acts-next.md)).
- **Buttons.** Its action button stays Grill; Mark as done doesn't replace it. The thread's Done is primary, in the accent color, while the card waits on it (`board/public/ui-threads.js` `doneButton`).
- **Questions win.** An open question on it is Action needed as before, with Open questions; `awaitsDone` holds only while the card has no action.

An ask waiting on the owner keeps its Action needed and Mark as done ([0035](0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md), [0059](0059-an-unstarted-card-waits-on-its-questions-in-todo.md)): its next step is often a pick only the owner can settle, not just closing it.

The owner asked for this on hub/GH-38: "I think items that need to be marked as done shouldn't stay as action needed. The next line is good, tap done once it is settled. But it's not quite action needed, it's just waiting to be closed out. So let's drop the badge and let's also not replace the grill button with Mark has done. We can still highlight the done button at the bottom."
