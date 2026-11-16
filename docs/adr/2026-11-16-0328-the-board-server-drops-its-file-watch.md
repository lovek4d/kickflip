# The board server drops its file watch

Card #897, split from #893 (owner, 11/16: "Drop the watch; the minute pass covers edits"). Since
[a store write tells its board server](2026-11-16-0312-a-store-write-tells-its-board-server.md), every store.mjs write
reaches its board server directly. The file watch was left only as a second path to the same signal, and the one that
fails: macOS drops its events under load, and on Linux it needed a watch per folder.

**No watch.** `watchTree`, its macOS recursive and Linux per-folder watches, `watchBoard` and `startServer`'s `watch`
option are gone. A board server learns of a write in `data/` or the item files' folder in three ways:

- A store.mjs write: in its own process through `changed(file)`, from another process by `POST /_claude/changed`.
- Its own writes outside store.mjs: `appendEvents` calls `changed(events)` after its append, and the files the board
  build reads (`queued-planners.json`, `headless-builders.json`, `landers.json`, `rebases.json`,
  `orchestrator-waits.json`) are written through `writeShown`, which calls `changed(file)`. The files only the passes
  read (`pulled.json`, `triaged.json`, `action-pushes.json`, `idle.json`) and the logs no pass or page reads
  (`audit.jsonl`, `limbo-waits.jsonl`) signal nothing: the pass that wrote one has acted on it already.
- Anything else, a git or hand edit of a repo-held item file or a lost POST: the minute pass
  ([the minute pass signals a write the file watch dropped](2026-11-15-0010-the-minute-pass-signals-a-write-the-file-watch-dropped.md))
  signals it within 60 s.

`changed(file)` no longer keeps the events file's own-append stat: with no watch to report the server's own append
later, every call is a new write and steps the data version once.

**What else read the watch.** Nothing outside the board server: the hub's sidebar stream (`hub/stream.mjs`) and the
orchestrator's watcher (`bin/wait-events.mjs`) keep their own watches of `data/`, out of this change's scope.

**Tests.** `board/server.bench.mjs` held only real-watch checks (the folder churn and the stream after a rename or in
a new folder), so it goes; `npm run bench` stays for the next timing check. `untilHeard` and `boardSees`, which waited
on the watch and had no callers left, go from `shared/test-helpers.mjs`.

Supersedes [the board watches each folder](2026-11-03-1517-the-board-watches-each-folder.md),
[the board watches each folder only on Linux](2026-11-03-1952-the-board-watches-each-folder-only-on-linux.md),
[a test waiting on the board to hear a write writes again until it acts](2026-11-13-0045-a-test-waiting-on-the-board-to-hear-a-write-writes-again-until-it-acts.md),
[the remaining write-then-wait tests nudge until the server acts](2026-11-13-0400-the-remaining-write-then-wait-tests-nudge-until-the-server-acts.md)
and [the folder-churn test builds its site aside and bounds its churn](2026-11-12-2135-the-folder-churn-test-builds-its-site-aside-and-bounds-its-churn.md).
