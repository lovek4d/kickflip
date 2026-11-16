# The attach icon sits inside the text box; the request row holds only its buttons

The owner on hub/T-507: "move the attachment icon back into the text box now that the buttons take up the bottom row". This amends [the request row is outlined buttons spread](2026-11-16-0630-the-request-row-is-outlined-buttons-spread-with-key-hints.md), whose row kept the attach icon at its end.

- **The icon is in the box, at its bottom-left corner**, like a chat composer: `BoardUI.dropZone` always draws `BoardUI.attachButton()` inside the box, and the box's bottom padding keeps typing from running under it. The `attach: false` option and the `.bare` box are gone, so a thread's reply box, each open question's note box, the New task box and the edit form all share one box.
- **`BoardUI.requestRow` draws only the buttons**: What's left? (a thread's reply box), Prototype, Grill and Visual.
