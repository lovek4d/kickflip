# Threads ride the board's sync, so the saved copy holds every card's thread

The saved copy (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md) kept only the threads the page had fetched. After a load the page fetched the threads of Todo, In Progress and In Review once, and opening any card fetched its thread again even when the copy held it. New and Done cards showed nothing until that fetch came back, and the others redrew when it did. The change-number sync carried the cards but never their threads. The owner asked for threads to ride the board's sync for every card on the board, Done included (#691, t349-sync and t349-which).

- **The board build makes each card's thread.** `domain.mjs buildBoard` already ran `threadOf` for every card. It now runs it a second time with the card's builder records (`agents`), which is the thread a page shows, and returns these as `threadViews`. The board's own fields (working, said, claudeAt) still read the first run, as before. `GET /api/thread` answers a card in an item file from this build, and makes the thread itself only for an archived card or an ask. On a copy of this board's data, the thread views for all 191 cards were identical to what `/api/thread` answered before. To match exactly, an event whose replies the build doesn't read now carries `replies: []`, as `withReply` gives it.
- **Threads are stamped beside the board, not in it.** `buildPageBoard` takes the views of the cards on the page board, and `sync.mjs stamp(sync, board, threads)` records each one as `{n, cut, len, h, appends}` in `data/sync.json`. A thread that changed steps the counter even when no card did. A thread that only gained lines (its old `len` messages hash the same) adds `[n, from]` to `appends`. Any other change sets `cut` to `n`. Only the newest `THREAD_APPENDS_KEPT` (50) appends are kept, and dropping one raises `cut` to its number. A card that leaves the board drops its record.
- **A patch carries what each thread gained.** `patchSince(sync, board, since, threads)` adds `threads: {<key>: {from, lines}}` for each thread changed after `since`: the lines from the first append after `since`, or the whole thread (`from: 0`) when `since` is below `cut`. A whole board carries no threads.
- **The page appends, or fetches when it can't.** `ui-patch.js threadPatch` appends a thread's lines when the held copy ends where they start, and takes a whole thread in place of the held one. A thread the page holds at any other length, or doesn't hold, is stale, and `app-threads.js takeThreads` loads it whole. `land` puts a patch's threads into `state.threadCache` before the board draws, so a thread line and the card change it reports show together.
- **A whole board fills every thread in the background.** After a whole board, `fillThreads` loads every card's thread (`ui-snapshot.js fillOrder`): the open cards' at once, then the rest four at a time, missing ones first. After a patch, it loads only the threads the cache still lacks. A load that has no board on screen to patch still fetches the open cards' threads beside the board, and `app.html`'s boot does too, but only when it has no copy.
- **Opening a card makes no request.** `app-cards.js` draws an open card from the cache, and loads only a card the cache lacks: a Done page loaded later, or a first load still filling. `loadThread`'s `maxAge` goes. A send still forces a reload of its thread afterwards. Its answer's patch already carries the board's own line, so the tap doesn't show a second time as landed.

**Size and time, on a copy of this board's data (hub-orchestrator, 191 cards: 1 In Review, 5 In Progress, 64 Todo, 121 Done; JSON bytes).**

| | before | after |
|---|---|---|
| saved copy (board + threads) | ~607 KB: the 428 KB board plus the 68 Todo, In Progress and In Review threads (179 KB), and any opened since | 1.52 MB: the board plus all 191 threads (1.09 MB) |
| loading every card's thread | 7.7 s: 191 `/api/thread` calls, 6 at a time, against the live server, each one making its thread | 0.84 s: 4 at a time, each answered from the build |
| one board build | ~300–400 ms | ~330–430 ms: the second `threadOf` per card adds about 30 ms |
| a patch after one new thread line | the card only; the open thread fetched again | 3.5 KB: the card and the one line |
| opening a card | one `/api/thread` request | none |

The data on disk is 4.6 MB, mostly threads of archived tasks no longer on the board. The copy sizes are the JSON length of what `copyOf` saves. IndexedDB's size on disk wasn't measured in a browser. The first patch each page gets after this change carries every thread whole (1.1 MB once), because `data/sync.json` has no thread records until the new code first stamps it.

Considered:
- sending every changed thread whole: simpler, but every progress line on a busy card would resend its whole thread to every open page;
- stamping each message: exact deltas even after edits, but `sync.json` would hold a hash for every message on the board;
- threads in the whole board as well: makes the first download about three times the size; the background fill gets the board on screen first.
