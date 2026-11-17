# A focused text box is the anchor from the moment it takes focus

The board's page anchor (`app-core.js`) was the focused field only when a repaint through `steady` found one. A box
that took focus between repaints stayed behind the topmost card as anchor, so a size change above the box but below
that card (an image loading, a thread growing) moved the box on screen, sometimes out of view.

Now a `focusin` on the board takes the anchor at once, and `focusout` hands it back to the topmost card on screen. The
resize watcher then holds the box in place by scrolling the page, as it does for a card. A scroll the owner makes
re-takes the anchor at the new scroll, so it is not fought. Covered by `board/topmost-anchor.test.mjs`.
