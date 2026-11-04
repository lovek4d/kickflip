---
status: accepted
---

# Archived Done cards are built as they page in, and the board drops the fields nothing reads

#201 audited what the board keeps for each card: wave.json items, owner.json questions, threads, builder records and the Done archive (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md). It listed who reads each field. Nearly every field has a live reader. The owner's answers (card-store-audit-notes.md, "Owner answers (11/04)" and "The build") settled what goes:

- **The archive keeps no page card.** Each entry used to store its card as the board last sent it (`slimDone`). Only `GET /api/done` read it, it went stale as the card's thread and links changed, and it was a third of the archive. An entry now keeps `closed_at`, the card's sortAt when it left, and `GET /api/done` builds its page of 100 (`server.mjs` `archivedCards`). `snapshot` reads the entries' items back into their wave files, beside the live cards, and their questions beside owner.json's. `buildBoard` then builds them as it builds the board, so an archived card still links the board cards that name it. Its PR states are the ones the server last read; a page-in asks GitHub nothing. Each card's sortAt is its stored `closed_at`, so the next page's cursor is the archive's own order (`store.mjs` `archiveRank`).
- **An archived card's own ask counts once.** `archiveCards` links a card's `from_ask` to it in `data/ask-links.json`, so the ask stays gone from Todo. A build that held both read that ask twice, once as made-from and once as folded in. `buildBoard` leaves a card's `from_ask` out of the asks folded into it.
- **Three fields nothing reads are gone:** a wave item's `summary`, and a question's `push_tag` and `no_change`. No code writes or reads them. `store.mjs` `stripDeadFields` removes them from wave files, owner.json and the archive. It also turns a stored page card into `closed_at`. The server runs it at start, after the follow-up migration. It writes only a file that still holds one, so after the first start it writes nothing.
- **A question's `resolved_at` stays.** The audit first said nothing reads it, but `domain.mjs` reads it: an answer newer than the resolve reopens the question. A resolve writes no thread line of its own, so the thread can't stand in for it. Showing it on the page is #217.
- **A closed card's builder progress lines stay in its thread.** They are a quarter of thread bytes, but a closed card's thread loads only when it is opened or paged in.

Measured on a copy of hub-orchestrator's data (235 archived cards), `GET /api/done` served locally:

| | Archive file | One page of 100 |
|---|---|---|
| Stored page cards | 1,007,899 B | read from the file |
| Built on page-in | 686,830 B | 46–88 ms |

The built cards matched the stored ones on every field for all 235 cards. The only exception was the ticket link, which the copy couldn't resolve without the hub's manifest. Before the ask fix above, 110 of them counted one thread message too many.

Considered:
- Keeping the snapshot and refreshing it on each write: a second copy of what the build already knows, with one more thing to keep in step.
- Building archived cards on their own, without the live waves: a parent lost its Done children still on the board, and a card read its wave as finished, since only finished cards were in it.
- Asking GitHub for an archived card's PR state on each page-in: up to 100 calls per tap for PRs that have closed.
