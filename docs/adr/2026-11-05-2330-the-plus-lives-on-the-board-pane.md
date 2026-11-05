# The + lives on the board pane and leaves the Questions page

On the desktop split view the + (new task) sits at the bottom right of the left, board pane: its right edge is the middle of the space right of the sidebar (`--sidebar-w`, 272px, 0 when the sidebar is collapsed), not the window's corner over the right pane.

The Open questions page has no + anywhere, phone and the desktop right pane included (the right pane's + is the board's, now on the left). shell.js leaves it out of that page, and the offset that lifted it above the page's bar went with it.
