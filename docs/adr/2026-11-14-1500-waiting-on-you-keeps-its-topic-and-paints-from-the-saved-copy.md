# Waiting on you keeps its topic and paints from the saved copy

On a phone, Waiting on you is a page of its own that the shell unmounts when the owner goes back to the board. Each return opened the first open topic again, and downloaded the whole board before painting anything.

- The page remembers the topic it last showed, per board, in memory for the app's life (not the URL, not across a reload). A return with no link opens that topic while it still has an open question, else the first open one as before. A link or push to a question opens its own topic.
- The page reads the board's saved copy (this build's) at mount, paints it at once, then asks only for the changes since its change number, as the board page does ([the board syncs by change number](2026-11-05-1819-the-board-syncs-by-change-number.md)). With no copy, or none from this build, the first load is the whole board as before. Out of reach still paints any build's copy.
- A load now waits for the copy read, so it starts a turn later than before.
