# Each text box sends its intent from a key, and attaches inside the box

The owner (#256): the New task sheet's Discuss/Quick build segment above Send becomes two buttons, Discuss on ⌘↵ and Quick build on ⌥↵, with no Send. Every composer's attach icon moves inside its text box at the bottom right, and dropping a file on the box attaches it, as attach.js already did. The thread's eye and fire stay where they are. Picked from the composer-keys prototype, take B: "more data for the incoming messages to clearly state intention deterministically."

**A composer's send buttons are its intents.** `BoardUI.sendButton(label, nth)` draws a box's first button on ⌘↵ and its second on ⌥↵ (Ctrl+↵ and Alt+↵ off a Mac), each with its key as a small gray hint shown only with a fine pointer, hover and at least 600px of width. `BoardUI.keyedSend` maps an Enter keydown to the button it presses, and the box submits through that button, so a key and a tap send the same thing. The submit handler reads the intent from `submitter`.

- New task: Discuss sends `ask {text}`, Quick build `ask {text, quick: true}`, as before.
- A Todo card's reply box: Reply sends `item-message {key, text}` and Reply and build `item-message {key, text, intent: 'build'}`, which the thread footers as "build requested" and the session treats as Mark ready and Implement (SKILL.md). The intent is recorded on the event, not inferred from the words. A card past Todo keeps one Send; the buttons follow the card's lane on each board load, as Done does.
- An edit box keeps Save on ⌘↵; a question note has no button of its own and sends from the questions bar's Send on ⌘↵.

**`BoardUI.dropZone` holds the attach button**, so every composer gets it inside the box from the one call, and the text keeps 40px clear under it.

Considered:
- ⇧⌘↵ for Quick build (take C): the owner picked ⌥↵.
- Two buttons only on the New task sheet (take A): the owner wanted the thread to state its intent too.

**Order on screen (#299).** The pair is drawn Quick build / Implement on the left and Discuss / Reply on the right, each keeping its colour and its key. `sendButton` marks a button with its `nth` (`data-nth`), and `keyedSend` presses the button by that mark, not by its place in the row.

Superseded in part by [threads say Reply, with Hold, Resume and Reopen beside it](2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md): every thread box's first button is Reply, carrying `intent: 'reply'`; no box is a lone Send.
