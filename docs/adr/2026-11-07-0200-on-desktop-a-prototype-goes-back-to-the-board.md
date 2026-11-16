# On desktop, leaving a prototype page goes back to the board, never to a standalone Open questions page

The owner, on #339: "returning from a prototype page on desktop should go back to the main page instead of open questions, again there should be NO open questions standalone page on desktop". Amends [back follows the page tree](2026-10-30-1125-back-follows-the-page-tree.md).

- **Page tree from 900px**: Waiting on you is the board's pane, so a prototype's only parent is the board (`router.js` `levelOf` and `parentsOf` take `wide`; `shell.js` passes the 900px query). The back arrow, the browser's back and a swipe all land on the board.
- **Choose this** replaces the prototype with the questions URL, as before. `shell.js` `go` turns any view of `questions.html` at that width into the board and picks the question's pill in the pane (`app-needs.js` `focusQuestion`, #312's focus), waiting for the pane to fill. A cold load or a history entry of `questions.html` is rewritten the same way.
- **Phone**: unchanged; the tree stays board, Waiting on you, prototype.
- #323 makes this one rule for every link; this card covers the prototype's return paths and the shell rewrite they need.

Superseded by [prototypes and visuals open in the reader sheet](2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md): a prototype is no level of the page tree; it opens in the board's reader sheet.
