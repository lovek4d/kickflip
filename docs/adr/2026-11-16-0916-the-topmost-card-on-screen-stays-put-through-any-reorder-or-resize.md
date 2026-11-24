# The topmost card on screen stays put through any reorder or resize

The owner (11/16): "Any time a ticket moves due to a lane change, filter change, etc. keep the page anchored on the topmost card visible … any time the page changes size or order it should keep that anchor." And: "If the card that moves is the only one visible, it should just follow."

`app-core.js` `steady` already held an anchor through each board repaint ([a card moving off screen leaves the visible cards where they were](2026-11-15-1030-a-card-moving-off-screen-leaves-the-visible-cards-where-they-were.md)), but an open card on screen outranked the topmost card, a repaint where every card on screen moved left the page wherever the reflow put it, and size changes outside a repaint moved the page freely.

- **The anchor.** The field being typed in, so typing never moves; else the topmost card on screen, meaning the first in page order with any part of its box in the viewport, so a tall open card whose top is above the screen still anchors. The open card no longer outranks it.
- **Through a repaint.** The first card on screen still in its lane after the paint holds still. When none kept its lane, the topmost one still shown holds still in its new place, so the page follows it. A card a filter hides or a lane shut has an empty box, so it counts as gone.
- **Between repaints.** `steady` keeps the anchor (a way to find it, and its top) after each paint. A `ResizeObserver` on the board's root and `#lanes` scrolls by however far the anchor moved on any size change: a card or lane opening or shutting, an image loading, fonts settling. A change `steady` or `holdBelow` already scrolled for finds the anchor where they left it, since both take it again after scrolling, so the watcher does nothing then.
- **The owner's scrolling** takes the anchor again on each scroll event that finds the page scrolled since the anchor was taken. Chrome can send a scroll event that scrolled nothing after a size change and before the watcher in the same frame (seen in `board/topmost-anchor.test.mjs`), and taking the anchor then would take the shifted layout.
- **A tap on a card's, lane's or Done fold's title** anchors that title for the change the tap makes. A lane title isn't a card, so opening a lane above the topmost card would otherwise push its title off screen.
- **A thread's folds** keep holding their reply form ([expanding in a thread grows it upward](2026-11-15-1600-expanding-in-a-thread-grows-it-upward.md)).

Amends [an open card moves at once and the page follows it](2026-10-30-1637-an-open-card-moves-at-once-and-the-page-follows-it.md): the open card's title row is no longer an anchor of its own.

Update (#1195): an open card whose thread's reply box has focus stays open through a lane change, the box keeping focus and its draft, and the page follows it; any other open card closes in its new lane as before.
