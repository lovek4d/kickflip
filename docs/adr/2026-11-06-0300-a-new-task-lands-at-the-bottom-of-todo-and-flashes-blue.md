# A new task lands at the bottom of Todo and flashes blue, and again when it becomes a card

The owner on #331 (11/05): "New tasks should show up at the bottom of the todo lane so they don’t move when ingested. Also they should get the blue highlight pulse on landing and post ingestion to a real item".

This supersedes in part [New Todo cards join the bottom](2026-11-05-2345-new-todo-cards-join-the-bottom.md) and [the + makes a New card](2026-10-29-1639-the-plus-makes-a-new-card.md) on where a New ask sits.

- **No New-ask band.** `laneOrder` (`board/public/ui-order.js`) lists Todo as bumped cards first, the latest bump on top, a bumped New ask included, then everything else oldest first by `sortAt`. A New ask's `sortAt` is when it was sent, so it lands at the bottom, and the card Claude files from it is made later and also lands at the bottom, so ingestion moves nothing.
- **Two flashes, one animation.** `signCards` (`board/public/app-snapshot.js`) flashes a New task once when it appears in Todo on a board the page already drew, and the work card that takes its place once more, with the existing `.flash` (`--color-info`).
