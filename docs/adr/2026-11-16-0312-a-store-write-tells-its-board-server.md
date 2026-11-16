# A store write tells its board server

A board server learned of a write made outside its own requests only through its file watch, which macOS drops under
load; the minute pass (2026-11-15-0010-the-minute-pass-signals-a-write-the-file-watch-dropped.md) recovers a dropped
write within 60 s. Owner (T-374): notify from store.mjs's writes, whoever calls them, by a POST to the board's port read
from the manifest; keep the minute recovery; drop the watch in a separate task.

Each store.mjs write (`replace`, so every `writeJSON`; `appendLine`; the notes file's write; the removes) calls
`wrote(file)`. It tells every board whose `data/` or item file's folder holds the file, the folders the watch covers:

- A board served in the same process (the board server's own writes, the in-process tests) through its `changed(file)`,
  which `startServer` registers with `tellOnWrite` where the watch starts, and drops on `close()`.
- Any other board in the hub's manifest by `POST /_claude/changed {file}` to its `port`, not awaited, so the write never
  waits on a server. The CLI sets `process.exitCode` rather than exiting, so its pending POSTs finish before it ends.
- A board whose server isn't up, or has no port, is skipped silently: it reads the write as it starts, or the minute
  pass signals it.

The server's `changed(file)` treats a told write as a heard one, so the events file's own-append check and the
ignored `data/sync.json` hold unchanged. With the watch still on, a write is usually signalled twice; the 100 ms quiet
window folds them into one signal.

- Each write reads the manifest and, for a file outside the board's `data/`, its `board.json`: a few small reads per
  write, nothing cached, since both can change under a long-running process.
- `archiveCount`'s write of `data/done-archive-count.json` tells no one: it caches a count the board build itself
  derives from the archive, so telling would only build the board a second time for one change.
- In-process test servers hear store writes as production servers do, so a test asserting "no event" after a tap
  ignores the waits check's record-only `orchestrator-waits` and `waits-history` lines.
- `hub/boards.mjs`'s direct append to `data/events.jsonl` tells no server: it runs only when the board's port refused
  the event or the board has no port, so no server is there to tell.
- Writes outside store.mjs (git or hand edits of a repo-held item file, the hub's own files) still reach the server
  through the watch, and through the minute pass once the watch goes.
