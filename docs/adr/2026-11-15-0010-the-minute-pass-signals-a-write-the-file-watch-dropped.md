# The minute pass signals a write the file watch dropped

Under load macOS FSEvents drops writes (T-279's measurements). The server rebuilt the board each minute, so the board saw a dropped write, but `changed()` never ran: no `event: change` to pages and no `checkAuto`, `settleLanes`, `fileNewAsks`, `checkArchive` or `markNewCards`, so a card readied by a dropped write was never pulled.

The minute pass now stamps the board (`pageBoard`) and, when the change number moved past the one before the stamp, calls `changed({ read: true })`: the same signal the watch sends, without stepping the data version, which the minute stepped already. The watch stays the fast path; a dropped write is acted on within 60 s.

- It walks no folder, so T-277's thousands of lock folders cost nothing. What it covers is what the board reads; notes files, read per request, are outside it.
- A write the watch did report and no page has read since moves the number too, so the minute may signal once more for it. The passes are idempotent, and the marks they write settle after one more minute.
- No direct CLI-to-server signal: `board.mjs` never contacts a board server, so that needs port discovery and an endpoint, and covers CLI writes only. T-374 holds the later move off the watch.
- `untilHeard` is unchanged.
