# A card moving off screen leaves the visible cards where they were

With no open card and no box being typed in, the board had no anchor, and the browser's own scroll anchoring is off on the board ([an open card moves at once and the page follows it](2026-10-30-1637-an-open-card-moves-at-once-and-the-page-follows-it.md)). A card leaving a lane above the screen, such as Todo to In progress, or a card added above, pushed everything on screen by its height.

- **The anchor.** After the field and the open card, the first card whose top is on screen is the anchor, provided it is in the same lane after the paint. A card that changed lane is the one leaving, so the next card on screen anchors instead.
- **Same task.** `app-core.js` `steady` scrolls by however far the anchor moved, as for the other anchors.
- **A tap on Done.** The card leaving the screen shifts the cards below it, so the page scrolls to hold the first of them still.

Lanes side by side on a desktop don't shift each other vertically, so this matters mostly on a phone's single column; the rule is the same.

Amended by [the topmost card on screen stays put through any reorder or resize](2026-11-16-0916-the-topmost-card-on-screen-stays-put-through-any-reorder-or-resize.md).
