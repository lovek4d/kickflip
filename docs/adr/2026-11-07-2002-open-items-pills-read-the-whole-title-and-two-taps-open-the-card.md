# Open-items pills read the whole title, and two taps open the card

Card #422. The owner, verbatim: "Full title is fine i just want it consistent, and again double tapping a pill should take you to the ticket on the main board".

- **One name for every pill.** `BoardUI.topicName` returns the topic's title, a card's being its ref then its title (`INT-92: Hub home rows`, `#422: Open-items pills`), so a Linear and a GitHub card read alike. An ask still reads the time it appeared. The old rule cut a title at the first `ID:` and so missed GitHub's `#N`.
- **Cut by width only.** The pill is one line; its name takes an ellipsis at the pill's width, the count stays beside it, and the full title is the hover title.
- **Two taps, not dblclick.** iOS Safari sends no `dblclick` on a touch double tap, so `view-questions.js` counts two clicks on one pill within 300 ms. Embedded in the desktop pane it hands the topic to `app-needs.js` `openOnBoard` (the card or band on the board, as the old dblclick did); alone on a phone it opens the board at `#item=<key>` through `AppShell.open`. A wave topic on a phone does nothing, since a band has no URL.
- **Toasts keep the ref.** "Sent 1 answer to INT-3." still names the card by its ref, not its title.
