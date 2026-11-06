# Done shows only in In Review, beside Reply

The owner (#302, from #229's thread): "Done truly should only exist in in review (which I would like to have two buttons like the todo, done and reply)", no Done in In Progress, and "close" in Todo. Picked from the done-in-review prototype, take A ("icons on the row").

- **In Review** (the review and stale lanes): the thread box sends with Reply (⌘↵, `intent: 'reply'`) then Done (⌥↵), a pair like Todo's. Done is `BoardUI.doneButton`, a send button with `data-confirm="finish"`: a tap goes to app-cards.js's confirm as before, and ⌥↵ submits the form through it, which the submit handler hands to the same `confirmTap`. Done keeps its tones: orange while it clears an ask's Action needed (`resolvedBy: BUTTON.done`), primary while a reopened card waits only on it.
- **In Progress**: one Send and no Done. Hold is the way to stop a running card (#229), so a landing card can't be closed mid-land from the board.
- **Todo**: Close, right of Hold in the card's actions row, with the same "Close <ref>?" confirm and `card-done`. The box keeps Implement and Reply.
- **A handled ask** waiting on the owner was already In Review (`placeOwnerWait`); its action-row Mark as done is gone, and the box's Done, in orange, is its one Done. `BUTTON.markDone` is now `BUTTON.done`, naming that button.
- `finishable` still means the owner may close the card (any open lane), and the server accepts `card-done` and `ask-done` from any lane; the lane picks where the button sits.
- **The row**: What's left? at the left, the eye, fire and attach at its right (`.icons`), the send buttons on their own line below. The reply box's text box has no attach inside (`dropZone(textarea, { attach: false })`); every other composer keeps it there.
- **No lightning.** An empty Implement on a card not yet ready sends the bolt's quick build, `item-message {key, text: 'Quick build', intent: 'build'}`; on a ready card it stays bare, and the board server starts the build at once, as before. Renaming Quick build to Implement in the New task sheet and the thread is #356.

Considered:
- Done then Reply, in the order the owner said it: the owner picked Reply then Done, as Todo's pair.
- Close in the reply box where Done was, or no close in Todo: the owner picked the actions row beside Hold.
- The icons inside the text box's corner (take B), or the pair beside the icons on one footer line (take C).

Supersedes [a lightning button in a Todo thread's footer starts a quick build](2026-11-05-0010-a-lightning-button-in-a-todo-threads-footer-starts-a-quick-build.md).
