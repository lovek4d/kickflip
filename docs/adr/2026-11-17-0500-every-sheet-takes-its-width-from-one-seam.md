# Every sheet over the board takes its width from one seam

Amends **Size** in 2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md.

From 900px the reader sheet, a card page (prototype or visual) and the questions sheet all take their width from
`--sheet-w` in style.css: the pane's width, else half the room right of the sidebar. A card page no longer widens to
60% of the room, so a wide visual cannot push the sheet past the pane; it scrolls inside its frame. No sheet kind
sets its own width, and reader-pane.test.mjs fails if any rule other than the reader sheet's sets width or max-width
on a desktop sheet selector, so an exception cannot land unnoticed.
