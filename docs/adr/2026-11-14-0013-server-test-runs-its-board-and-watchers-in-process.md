# server.test runs its board and its watchers in process

Card #666, from the test audit (docs/test-determinism-audit.md, F1a), after [the board server starts in process, and its tests await settled()](2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md).

board/server.test.mjs's shared board server runs in the test process, with no file watch. A write the server would hear of through its watch, the test reports itself: `heard(...files)` calls `changed(file)` for each, then awaits `settled()`. `putWave` awaits `settled()`, replaces the item file, and has the server hear it. The server awaits each launch it makes, and a launched `true` exits at once. So by the time `putWave` writes, every earlier launch has exited and its exit path has written the item file. That replaces the poll for launched pids. Every `boardSees`, `untilHeard`, `cardsMarkedRead` and file-watch `until` row becomes a write, `heard`, and a plain assertion. A test that counts events before and after a request awaits `settled()` before the first count.

Asserting after `settled()` means the server's passes have run on a write before the test reads the files. A test that compared the item file with what it wrote now compares it with the file as those passes left it. A fixture card stands in the phase its scenario has, so a pass doesn't add what a New card would get.

The watcher rows run bin/wait-events.mjs's `watch` in the test process. Its sleeps end only as the test takes passes (`watching(session)`), so a test acks a ping in one pass instead of polling handshake.json. This supersedes the line in [the watcher runs in process on an injected sleep](2026-11-13-2215-the-watcher-runs-in-process-on-an-injected-sleep.md) that kept server.test's watcher rows spawned. hub/close-board.test.mjs's still spawn the script.

The stream test splits. server.test checks that a write the server hears sends one uncompressed change. The real-watch rows (a rename replacing the file, a folder made after the stream opened) move to board/server.bench.mjs, since only a real OS watch tests them. The try test and the sync test start their own servers in process too. The two `spawnSync` tests that freeze Date in a child drop their time limits, so the per-file timeout is the only ceiling.

One timer wait is left: the held card's Merge runs a detached merge child, which the test waits out until the server takes a merge runner (F6).
