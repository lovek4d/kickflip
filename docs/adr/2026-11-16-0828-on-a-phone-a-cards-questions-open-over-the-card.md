# On a phone a card's questions open over the card

The owner, on T-516: "Opening questions modal on mobile still goes to the questions page". A card's question link (the header's ? for the selected card, a card's Answer link, a push on a card's question) is a questions-page URL. `shell.js go` sent a questions view to the board only from 900px, so a phone navigated to Waiting on you, which opened the topic's sheet over the list. The questions sheet is mounted on the board at every width, so the phone can do what the desktop does.

- **Which URLs.** Below 900px a questions view whose id names a card's question or topic (a topic `item:<key>`, `BoardUI.cardOfQuestion`) shows the board at its own URL, by the same `inPane`/`paneAsk` path the desktop takes. Waiting on you with no id, and a topic of no card (a board-level one, such as an overnight triage), stay the page.
- **Deciding without the board.** A question id says nothing of its topic, so the shell asks the board of that route mounted here, shown or kept behind its Waiting on you. With none loaded (a cold load, a push from another board) the shell goes to the board, and the board, once loaded, sends a topic of no card back to the page by replacing the entry, so the questions URL stays the one history entry.
- **What the board does.** With no pane, `focusQuestion` opens the card on the board (the selection, `pane: false`), closes the reader and opens the topic's questions sheet over it, a topic id included (from 900px a topic id only marks its pane row). Closing the sheet leaves the card open. A tap on the board's own link adds no history entry, as from 900px; one from another view or board pushes the board, so Back returns there.

- **A card's row on Waiting on you.** On the phone's Waiting on you page a card's topic row opened the page's own sheet over the list, while a row in the desktop pane focuses the card on the board under the board's sheet. The row now opens its topic's questions URL through the shell, so it takes the path above: the board with the card open under its sheet, and Back returns to Waiting on you, as a Pick a take row already does for its prototype. A topic of no card still opens the page's own sheet.

A divergence found in the same audit and kept: from 900px opening a card opens its questions sheet (`app-questions-sheet.js followCard`); on a phone it opens nothing, since the modal sheet would cover the card just opened.

The pane itself, the switch between the board and Waiting on you kept mounted together, the sheets' modality and sizes, and the pane's pill replay are layout, not divergences.

Amends [board and open questions are two pages](2026-11-07-1300-board-and-open-questions-are-two-pages.md) and [a thread's questions open in a sheet from their line](2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md).
