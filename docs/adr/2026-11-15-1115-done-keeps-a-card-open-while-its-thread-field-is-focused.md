# Done keeps a card open while its thread field is focused

A Done tapped with the card's thread field focused leaves the card open, and the page follows it to Done, since
app-core.js steady anchors on the focused field. Any other Done closes the card in place, as before.

The focus is read at the tap (app-cards.js confirmTap), before the confirm dialog takes it, and a thread-box Done
carries it through the outbox as `follow`. A click that moves focus onto the button itself counts as not focused.
