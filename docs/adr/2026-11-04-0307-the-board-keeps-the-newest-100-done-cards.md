---
status: accepted
---

# The board keeps the newest 100 Done cards, and older ones page in from an archive

Every board build read every Done card ever closed, with its resolved questions, and `/api/board` sent them all whole. On the hub-orchestrator board that was 322 Done cards, nine-tenths of the download. The owner's answers on #190 (card-retention-notes.md, "Owner answers (11/04)") settled the shape: the newest 100 Done cards stay, slim; older ones go with their resolved questions to an archive file the build doesn't read; threads stay whole; the Done list pages the archive in as you expand it; triage keeps Todo and adds stale cards.

- **Past the newest 100, a Done card moves to the archive.** `domain.mjs` `archivedOf` picks the finished (done, merged, dropped) work cards past the newest `DONE_KEPT` (100) by closing time. It leaves a card that a lineup band shows, one an unfinished card names as a dep, parent, child or related card, and one with a question still open or answered. The server (`checkArchive`) runs it at start, right after the follow-up migration, and after each board change. It checks the shared build first that anything is past 100 (docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md), and only then reads the board a page gets, whose cards it archives.
- **The archive is one file, `data/done-archive.json`.** Each entry keeps the card's page card as last sent (`slimDone`; since #201, its closing time instead: docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md), its wave file entry, its resolved owner.json questions, and the asks it was made from. Entries are sorted newest closed first. `store.mjs` `archiveCards` writes the archive before the wave files and owner.json, under its own lock, and re-reads the files under that lock. A stop part way leaves a card in both files, and the next run moves it again. An empty archive is no file.
- **An ask stays gone into its archived card.** A card's `from_ask` is how the board knows its ask became a card. When the card leaves, `archiveCards` links the ask to it in `data/ask-links.json`, so the ask doesn't come back as a New card in Todo.
- **Threads, notes and builder records stay where they are.** `GET /api/thread` reads an archived card's item and questions from the archive, so its thread opens whole.
- **A command that names an archived card brings it back.** `store.mjs` `loadItem` and `appendThread` restore it to its wave file, with its questions and ask links, before they act. A reply, a reopen or `item set` works on it as on any card. If it is still past 100 after that, the next check moves it back.
- **`/api/board` sends Done cards slim.** `domain.mjs` `DONE_FIELDS` lists what the page draws for a Done card, closed and open. Agents, created times and the rest stay on the server. `doneArchived` says whether the archive holds anything. The page's first-paint snapshot now stores cards as the board sent them, because the board does the slimming.
- **The Done list pages the archive.** Done still shows 10 more per Show more. Once the next 10 would pass the cards the page holds and older ones wait, the tap fetches `GET /api/done?before=<sortAt>|<key>`. That returns the next 100 archived cards and how many are `left` after them, and the list keeps paging the same way. Until the first fetch, Done's count reads "100+" and its Show more says "90+ older cards", because the page doesn't know the archive's size yet.
- **Triage reads Todo and Stale.** `domain.mjs` `todoOf` adds stale cards, and Done leaves by the rule above, never by triage.

Measured on a copy of hub-orchestrator's data (346 wave entries, 322 Done cards), `/api/board` served locally, median of 15 loads:

| | Raw | Gzipped | Median build |
|---|---|---|---|
| Before | 791,884 B | 104,789 B | 116 ms |
| After | 257,043 B | 40,322 B | 72 ms |

The start moved 222 cards and 280 resolved questions to the archive (947 KB), and kept 124 wave entries. Every wave entry and question is still in the wave file, owner.json or the archive, unchanged. Thread files are untouched.

Known gap: a card that moves to the archive while a page holds older pages it had already fetched can drop out of that page's list until it reloads.

Considered:
- Trimming in the board build only, with the full wave files still read on every build: the read itself was the cost.
- An archive file per wave: one file keeps the paging route a single sorted read.
- Archiving from triage, as the notes first suggested: the owner chose a rule, so triage stays on Todo.
- Refusing commands on archived cards: a reply to an old card's thread would fail with nothing to tell the owner why.
