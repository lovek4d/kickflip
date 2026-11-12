# Done lists every card with no wave fold, and a card names its wave

The owner (card #622) asked to drop waves from the Done lane. A finished item file's Done cards no longer sit under one fold row: every Done card is in the one newest-first list, with the archive pages after it. This supersedes the finished-wave fold of [answered asks fold into the one Done list](2026-11-09-1430-answered-asks-fold-into-the-one-done-list.md).

- `domain.mjs` no longer sets `fold` on a card, and `fileFold` is gone. `finished` stays on the item file, which still decides whether its wave band shows in the other lanes.
- `app-lanes.js` draws no file fold; Done's count is its cards, counted once.
- The Reviews lane's "Earlier" fold keeps the shared fold styling.
- A card in a wave (`it.wave`, set by `waveBandsOf`) draws a muted `Wave: <title>` line under its status line in every lane (`ui-cards.js` `workLines`); a card in no wave draws none. With Done's fold gone, this line is how a done card still shows its wave. The slim Done form (`DONE_FIELDS`) keeps `wave`, so an archived card shows it too.
- A card in no declared wave names its item file instead (`fileLabel`, its file's title) when the board has more than one item file, which is what the dropped Done folds grouped; on a one-file board such a card shows none.
