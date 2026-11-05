# The split view's right pane contains its scroll

From 900px the board is the page's own scroll and the right pane is a sticky box with its own scroll, so scrolling either never moves the other. The one shared motion was chaining: reaching the end of the pane scrolled the page, moving the board. The pane now has `overscroll-behavior: contain`.

The board stays on window scroll rather than becoming a second fixed-height scroller, so restoring scroll, scroll-to-card, `#item` links, the sticky header, the prototype viewer's scroll keeping and the pill focus all keep using the window unchanged. Below 900px the page scrolls as before.
