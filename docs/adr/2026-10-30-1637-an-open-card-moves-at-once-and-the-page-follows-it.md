# An open card moves at once and the page follows it

A repaint ([a repaint patches in place, so nothing waits while you type](2026-10-30-1122-a-repaint-patches-in-place-so-nothing-waits-while-you-type.md)) re-sorts the lanes from the new board, so an open card can change lane or place, and cards above it can appear, go or reorder, while the owner reads or types in it. The board shows the new order at once, and the page's scroll follows so nothing the owner is looking at jumps.

- **The anchor.** The text box being typed in on the board, such as a reply or an edit box, is the anchor. With none focused, the title row of the open card on screen is. With no open card on screen there is none, and nothing is corrected. A box in a dialog, such as the + sheet, doesn't move with the page, so the open card anchors then.
- **One task.** `app-core.js` `steady` measures the anchor's top, runs the repaint, gives focus back if it was lost, then scrolls the page by however far the anchor moved, all before the browser paints. Everything above the anchor shifts, the card's own new thread messages included; a change only below it moves nothing. `overflow-anchor: none` on the board's page keeps the browser's own scroll anchoring from correcting the same shift again.
- **No animation.** The card snaps to its new lane or place with no chip, banner or delay.
- **Focus survives the move.** A blur closes the iOS keyboard, so the box never loses focus when its card moves ([a repaint patches in place, so nothing waits while you type](2026-10-30-1122-a-repaint-patches-in-place-so-nothing-waits-while-you-type.md), the same node).

The owner asked that the page not shift under a focused text box (hub/INT-140), and on the prototypes chose "track the movement of the card and scroll accordingly? no animation, just snap it over when moving" (question `moved-open-card`), with the box staying still (question `track-anchor`, take `box`).

Considered:
- holding an open card in its place until it closes, with a chip, a banner or silently: the board would show a lane that isn't the card's, and the owner rejected it for the snap;
- anchoring the open card's title row even while a box is focused: a new message in the card's thread would push the box down under the owner's thumb;
- pinning the lane the card moved into under the page header: it covers what is under it, and the card's lane already shows on its status dot.
