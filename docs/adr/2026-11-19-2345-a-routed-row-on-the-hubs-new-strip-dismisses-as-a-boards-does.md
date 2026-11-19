# A routed row on the hub's New strip dismisses as a board's does

Nothing removed a row from the hub page's New strip: a routed request stayed once filed.

A routed row (and a moved one, and an answered cross-board ask) now carries the board's X, with no confirm, and following
its link to the card dismisses it too. A row still waiting, or an ask not yet answered, has neither.

The dismissal is the hub's state, not the page's: `hub/router.mjs dismissRow` keeps the row ids in
`~/.claude/kickflip/routed-dismissed.json` (the newest 500), `routedRows` leaves them out, and the page posts the id to
`/_hub/api/dismiss-row`. So every device sees the same strip. A board's strip keeps its read marks per card on the board
(docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md); a hub row has no card of the hub's own, so the row id is the key.
