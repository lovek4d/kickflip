# Notes ride the board's sync, and a failing main's log rides the board

The saved copy held the board and every card's thread (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md), but a card's notes were still fetched each time they opened: the reader sheet showed "Loading…" and Notes showed "Loading the notes…" until `GET /api/notes` answered. Main's failure sheet fetched `GET /api/try/main/log` the same way. The owner asked why notes still load when they should be kept in the local copy (#760). They chose notes only for the local copy, with transcripts, logs and Done pages staying on demand, and asked for main's failing-try log to ride the sync while main is failing.

- **The build reads each card's notes.** `server.mjs sharedBoard` adds `cardNotes` to the build, once per data version: each card's markdown, read as `GET /api/notes` reads it (`store.mjs itemNotes`), or null for none or for a notes file that fails `planPath`'s checks or is gone. A write to a notes file already moves the data version, since the server watches the item files' folders.
- **Notes are stamped beside the board, as threads are.** `buildPageBoard` maps each card on the page board to its notes (null for none), and `sync.mjs stamp(sync, board, threads, notes)` records each as `{n, h}` in `data/sync.json`. Notes that changed step the counter even when no card did. A card that leaves the board drops its record.
- **A patch carries changed notes whole.** `patchSince` adds `notes: {<key>: markdown or null}` for each card whose notes changed after `since`. A whole board carries none.
- **The page keeps them in the saved copy.** `state.notesCache` holds each card's notes. A patch's notes go in before the board draws (`app-reader.js takeNotes`). After a whole board, one `GET /api/notes?all=1` loads every card's notes at once (`fillNotes`). A key a patch brought while that request was out keeps the patch's notes. `copyOf` saves the notes of the cards on the board beside their threads, and `paintCopy` puts them back.
- **Opening notes makes no request.** The reader sheet draws a card's notes from the cache in the same tick as the tap, and draws them again when a patch or fill brings them changed while the sheet is open. Only a card the cache lacks, such as a Done card paged in later or a first load still filling, fetches its own. The Notes page paints from the board's saved copy at once, then takes the live answer. Out of reach, it shows that copy, else its own last answer, under the copy line.
- **A failing main's log rides the board.** While `data/try.json`'s main is `failed`, the snapshot reads the last 40 lines of `data/try/main.log` (`tryLogTail`, as before), and `domain.mjs` puts them on the board's `main` as `log`. At any other state `log` is null. The sheet draws `main.log` at once and again from each board that brings different lines, and keeps the last lines while main rebuilds. `app-cards.js loadMainLog` goes. `GET /api/try/main/log` stays, but nothing on the page reads it now.

**Size and time, on this board's data (hub-orchestrator, 170 cards in `data/items.json`, 169 with a notes file).**

| | before | after |
|---|---|---|
| notes of every card | fetched one card at a time, on open | 517 KB as JSON, one `/api/notes?all=1` after a whole board; median file 1.6 KB, largest 17.9 KB |
| reading them in a build | none | about 1 ms warm, 7 ms cold, for all 169 files (provisional: the host was busy, load average 7 to 9) |
| a patch after one notes edit | the card only, if anything on it changed | the card's notes whole |
| opening notes | one `/api/notes` request | none |
| main's failure sheet | one `/api/try/main/log` request on open and after each failed retry | none; at most 40 lines ride `main` while failing |

The first patch each page gets after this change carries every card's notes whole (about 0.5 MB once), because `data/sync.json` has no notes records until the new code first stamps it. The copy grows by the same amount. IndexedDB's size on disk wasn't measured in a browser.

Considered:
- appends for notes, as threads have: notes are mostly appended sections, but they are edited in place too, and a median 1.6 KB file costs little to resend;
- notes in the whole board: about doubles the first download (the board is about 430 KB); the fill gets the board on screen first;
- filling notes one card at a time, like threads: 170 requests where one does, and every card's notes come from the one build anyway.
