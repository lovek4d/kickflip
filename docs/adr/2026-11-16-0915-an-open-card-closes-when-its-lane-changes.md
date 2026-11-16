# An open card closes when its lane changes

A card the owner had open comes back closed when a repaint finds it in another lane, whether a tap, a board change from the server, a builder picking it up or a land moved it. The board forgets it as open (`openItems`, which a reload restores), and the URL's `#selectedCard` is left alone: the card stays selected, closed.

The close happens in `render` before `steady` picks its anchor, and `steady` anchors on the title of an open card only when the board still holds it open. A moved card no longer anchors the page, so the page keeps the first card on screen still in its lane (docs/adr/2026-11-15-1030-a-card-moving-off-screen-leaves-the-visible-cards-where-they-were.md).

A card the owner opens after the move stays open: only a lane change between two paints closes one. This replaces the Done tapped with a thread field focused keeping its card open: that card now closes too.
