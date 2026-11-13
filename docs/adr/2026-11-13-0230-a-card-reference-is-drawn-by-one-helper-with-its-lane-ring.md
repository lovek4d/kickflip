# A card reference is drawn by one helper, with its lane ring

The owner (T-238, filed as T-260) saw "Created ticket #620" as plain text and "Created from hub/T-238" naming a card by
its key. Every ticket number should link to its kickflip card with its status icon, read the card's latest ref, and
never show the `<file>/<id>` key. The one exception is the badge in a card's own header.

- **One helper, `BoardUI.cardRef(key, ctx)`** in `board/public/ui-links.js`, draws a card named by key: the ref the
  card has now (its ticket once it has one, else its id), as a `taskLink`
  (docs/adr/2026-11-13-1120-every-task-reference-links-and-shows-its-lane-ring.md), so it links to
  `#selectedCard=<key>` and ends with its lane ring. A card that left the board reads by its id. Refs in written text
  (`linkText`) and thread lines naming a card go through it. The details list's link labels and a wave's Done row
  already carry each card's ref and lane from the board, so they call `taskLink` directly.
- **A line names a card by key, and is drawn when it shows.** `domain.mjs` `namedLine` gives each such line its `card`
  (key) and `words`. These are Related to, Unrelated from, Follow-up, Follow-up of, Created ticket and Created from
  from `postLinkLines`, and an ask's Became, Added to and Moved to. A card's own Created ticket line (`ticket-made`)
  names the card itself. The page draws `words` then `cardRef(card)`. The line's `text` reads the same words and the
  ref from the board's cards, for any reader without the page. `/api/thread` now passes the board's cards, which it
  did not before, so the "Created from hub/T-238" fallback is gone.
- **A ref in the board's own status line links too.** A line such as "Paused: blocked by #620" is drawn through
  `linkText`, as a message is, so its refs go through `cardRef`.
- **Titles are gone from these lines.** "Related to #12: Tidy" reads "Related to #12". The ref is the link, and the
  card it opens holds the title.
- **A thread that answers before its board waits for it.** `loadBoard` fetches the open threads beside the board, and
  each thread drew as soon as it answered. The small thread answer could draw "Created ticket #631" before the larger
  board answer brought the header's ticket badge. `loadThread` now takes `after`, the board load's landing, and draws
  only once that board has landed or failed, so the line and the badge show in one update. The store already writes
  the item file before the line (`store.mjs` `item set`), so the server order was right; the gap was in the page.
