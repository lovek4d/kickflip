# A repaint patches in place, so nothing waits while you type

Lanes, threads and chips update while the owner types. A box being typed in, whether a message's edit box, a card's reply box or the + sheet, keeps its text, cursor and focus through every repaint.

- **Patching.** `ui.js` `setHTML` patches a region in place instead of replacing its markup. A node stays when the new markup has one of its tag at its place, and an element with a key (`keyOf`: a card, a thread, a message, an edit box, a lane or a fold) stays wherever it was in the region, so a card that changes lanes moves with its open thread. A textarea keeps what was typed in it. The lanes' patch leaves each open card's thread to `app-threads.js` `renderThread`.
- **The same node.** The box being typed in is never re-created, so iOS keeps its keyboard up. A card that changes lanes moves its node, which blurs it, so `app-core.js` `keepFocus` gives focus and the cursor back after each repaint, opening the lane or fold the card moved into when it is closed.
- **The edit box is state.** An open edit box is `state.edits`, by its message's event id, holding its text as the owner types, and `ui-threads.js` `threadMessages` draws it in place of the message's text. It stays until Save or Cancel, also when Claude takes the message up meanwhile.
- **The + sheet** sits outside the lanes, so no repaint touches it.

The owner asked that being in edit mode not block a new thread message from showing (hub/INT-128), then chose "nothing pauses while you type" (question `typing-refresh`).

Considered:
- pausing a region's repaint while a box in it is open or focused, which held new thread messages, lane moves and chips back until the owner left the box;
- re-creating the region and copying the box's text and cursor into the new one, which blurs the box and closes the iOS keyboard on each repaint.
