# Card state comes from one snapshot reader the server, the CLI and the store share

Only `buildBoard` (domain.mjs) decided a card's lane, what blocks it and whether it has finished, but the snapshot it
needs was read only inside the board server's `startServer` closure (`itemSnapshot`, `snapshot`). The CLI and
store.mjs couldn't reach it, so store.mjs wrote the same rules again over the stored fields: `closed` (stored lane Done
or `reopened_at`), `unfinishedDeps`, `blockerNames` and `blockWords`. The two disagreed whenever the board read a card
as Done before the server's `settleLanes` stored the move: an owner's Done tap (`tappedDone`) or a merged PR. A CLI
write while the server was down read the stale lane. A card whose dep had merged was still blocked for `item set
--start`, `merge`, a Merge tap and `land` (T-596 architecture review, finding 1; the owner took option A).

`board/snapshot.mjs` is now the one reader:

- `readSnapshot(site, outside, {archived, items, home})` reads everything `buildBoard` needs, as the server's closure
  did. `outsideData(site)` reads the board's `outside` (board.json, its manifest entry, topic items, the usage gate).
  `items: true` reads the item files, their threads and the settings alone, which the server's `reviveHeadless` uses.
- `builtCards(site)` builds the board from the whole read and gives its work cards by key. Every CLI guard reads its
  card from here (store.mjs `shownCard`), so a command reads the lane, `blockedBy` and `finished` the page draws, with
  the server down too. A full build of the hub-orchestrator board (171 cards) took 110–235 ms, measured while the host
  was busy, so the number is provisional; a guard builds once before its write, and again after it only when the
  write's effect depends on the new state (a block's pause, a lifted block, the cards a close unblocks).
- The board server, the test fixtures (`board-fixture.mjs` `reviewProbe`) and store.mjs all read through it.

domain.mjs holds each rule once:

- `finished` on every work card: lane Done, or reopened since (the owner's Reopen too). `blockedBy` is the deps that
  haven't finished.
- `blockWordsOf(card)`: "by #53, #54 and until <condition>", which the CLI's refusals and the card's Merge line read.
- `landSkipOf(card, skip)`: what a verified card's land skips for. A gone worktree still goes first, then what blocks
  the card, then an open question. store.mjs `landable` no longer works out the block itself: the snapshot reader calls
  it before any card is built, so it lists every verified, handed-back card, and its callers apply the built card's
  block and `finished`. The card's land step is now taken in `buildBoard` once `blockedBy` is known.

Commands that write a card's stored lane still read and write the stored field: `placeIn`, `markUnblocked`,
`lostLaunches`' In Progress check, and `builder start`'s move into In Progress. Guards on the lane read the built card:
`item set --phase`, `item brief`, a Grill or Prototype tap (`planAgain`) and `restageStaleReady`.

This extends docs/adr/2026-10-29-1639-card-logic-lives-in-one-pure-module.md from pages to the CLI.
