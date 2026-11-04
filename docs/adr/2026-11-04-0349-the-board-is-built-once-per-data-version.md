---
status: accepted
---

# The board is built once per data version

On 11/04 the hub-orchestrator board server sat at 72–75% CPU for nine minutes while many builders wrote progress lines. The grill on #199 (server-cpu-notes.md) measured why: each progress line is one change signal, and each signal built the whole board once for every reader, one after another: the archive check, the stalled-builder check, the Action needed check, the Auto jobs and each open page's `GET /api/board`. Inside each build, `threadOf` filtered the whole event log several times for every card. The owner's answers (gh199-share: cache, gh199-build: index, gh199-debounce: keep) settled the fix.

- **One build per data version.** `server.mjs` keeps `dataVersion`, a counter. It steps on each write the watcher sees (`changed`, before the debounce). In a request other than GET or HEAD it steps as the request starts, so the request reads the files as they are; again before each read after its own writes (`pageBoard`, `recordAnswers`); and as it answers (`send`). It also steps once a minute, since the board reads the clock (stalled builders, late checks, holds), and when gh brings back a PR state that differs from the one held. `sharedBoard()` builds `buildBoard(await snapshot())` once per version, and every reader of that version awaits the same build. Readers never change it: `board()` copies the cards whose worktree is gone instead of nulling them in place.
- **What the board reads outside its watched folders is part of the key.** `board.json` sits in the site's root, the board's GitHub repo, git remote and branch come from the hub's manifest, and topic items from the Slack bridge's files; the watcher sees none of them. `outsideData()` reads them on each `sharedBoard()` call, a few small files, and the cache is keyed by the data version and their content, so an edit to any of them rebuilds the board on its next read. The snapshot reuses what `outsideData()` read.
- **A read can trail an outside write by the watcher's delay.** A write by another process, such as a builder's progress line, reaches the version once the watcher reports it, about 13 ms on macOS. A GET in that gap gets the build from before the write; the change signal that follows makes every page read again. Tests that write a board's files and read at once wait for the board to move (`shared/test-helpers.mjs` `boardSees`).
- **Every check reads the full board.** The checks used to build their own partial boards: without PR state, without replies, or without events. They now read the same build a page does, so the Auto jobs and the stalled, pick-up and archive checks see the replies and PR states the page shows.
- **The hub's side is added per read.** The session's pending prompts and whether it listens come from the hub's files, outside the board's data, and reading them spawns `ps`. `domain.mjs` `withHub` adds them to a build (prompts lead Needs you, `listen` names the watcher's state), and `board()` applies it to the shared build each time. `buildBoard` applies it to its own snapshot, so a build with prompts and listen gives the same board as before.
- **A build groups events and questions once.** `domain.mjs` `threadIndex` groups the item events by card key, owner answers by their question's topic, asks by id and ask edits by the ask they edit, with each event's place in the log, and `buildBoard` hands it to every `threadOf`. Each list keeps the log's order, and a thread that merges lists (its own key and its asks') sorts them back into it, so lines at the same moment keep their order. `ownerQuestion`, `ownerTopics` and the card's questions take pre-grouped answers, requests and questions. `checksOf` takes the newest write in one pass instead of sorting every thread line. `threadOf` called alone builds its own index.
- **The debounce stays 100 ms / 500 ms.** Follow-up #208 grills the owner on it.

Measured on a copy of hub-orchestrator's data (the server from this repo on a spare port, HOME a scratch home, gh and claude stubbed to fail, Auto's pull, triage and headless launches off; one simulated page holding `/api/stream` and reading `GET /api/board` with If-None-Match on each signal; progress lines through `store.mjs` `builderProgress`; CPU from `ps cputime`):

| | Builds per signal | CPU per line | 20 lines, 500 ms apart | JS in the burst |
|---|---|---|---|---|
| Before (2d3fa8f) | 5 | 0.53 s | 8.7 s over 12.1 s, 72% of a core | 4.4 s |
| After | 1 | 0.17 s | 2.8 s over 12.1 s, 23% of a core | 1.1 s |

`buildBoard` went from 65% of the burst's JS time to 19%. The largest share now is reading reply files (`withReply`) for every event that may have one, on every build.

`board/server-builds.test.mjs` counts the server's reads of the wave file, which each build reads once, across one change signal and the page load it causes: one, where it was five.

Considered:
- Expiring the cache by time: the board would serve a build that a write had already outdated.
- Keying the cache on the hub's prompts and listen state: reading listen spawns `ps`, so each check would pay for it.
- Passing one build from the change signal to each check: a page's `GET /api/board` and the minute checks would still build their own.
- Rebuilding for every GET that isn't a page's reload: the server can't tell a reload from a first load, and a reload is most of the GETs.
- Watching `board.json` and the hub's manifest: the manifest is the hub's, shared by every board, and its watch would wake every board for any board's change.
