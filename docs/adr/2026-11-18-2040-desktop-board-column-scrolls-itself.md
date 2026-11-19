# The desktop board column scrolls itself

From 900px the board column (`.split > main`) is its own scroll container, 100vh minus the header, and the window does not scroll while a board shows. The board's bar sits on the left pane's right edge instead of the window's far right, where an open sheet's bar made two. Below 900px the page still scrolls.

The scroll code in `app-core.js` reads and moves the column on desktop and the page on a phone (`column()`); its scroll listener is captured on the document so both reach it.
