# On desktop the questions sheet follows the opened card unless the owner opened it by hand

From 900px the pane keeps Waiting on you's full list, so a card opened on the board no longer showed its questions. The questions sheet (app-questions-sheet.js) carries one flag, autoOpen.

- Opening a card, with no sheet open or an autoOpen one open, opens that card's questions sheet with autoOpen true, replacing the followed one. A card with no open questions closes an autoOpen sheet.
- A sheet the owner opens (a Questions line or button, a pane row, a question link) opens with autoOpen false and replaces whatever was open. Opening a card never replaces it.
- Closing a sheet by hand leaves none until the next card opens. Below 900px nothing follows.

Considered: expanding the card's row in the list (the owner wanted no expanding in place), and dropping the matching.
