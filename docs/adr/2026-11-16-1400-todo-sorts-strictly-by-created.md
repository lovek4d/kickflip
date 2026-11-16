# Todo sorts strictly by created

Todo lists its cards by the time each was created, with no fallback. It used to fall back to a card's latest activity when the card had no created time, so an old held card could sort below newer cards, and a new task landed above it.

Every card gets `created` when filed. A card without it takes the time of the first line of its thread, once, as the board server starts (store.mjs `migrateCreated`). A Todo card still without `created` after that has no sort time and lists last; it never sorts by its activity. The board does not throw on it: one such card would take the whole board down.

In Progress and Done keep the latest-activity fallback; this changes Todo only. It supersedes the fallback sentence in [each lane has one fixed order](2026-11-03-0223-each-lane-has-one-fixed-order.md).
