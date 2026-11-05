# On the desktop, double-clicking a questions pill focuses its card on the board

From 900px, a double-click on a topic pill in the Waiting on you pane opens that topic's card on the board at the left and scrolls to it, as a `#item=` link does. The owner, on #316: "open questions on desktop, double clicking the pill should focus that item on the board at the left". A single click still picks the pill (#312 is the reverse direction).

- **Which topics**: `item:<key>` is a card, including an ask (`item:ask:<id>` is the card `ask:<id>`); `wave:<slug>` is a band, which opens and scrolls into view. The board's `focusOnBoard` (`app.js`) does both; the pane's listener is in `app-needs.js`.
- **A topic the board doesn't show** (any other topic, a card or band no longer on the board) does nothing.
- **Phone**: no pane is mounted, so nothing changes.
