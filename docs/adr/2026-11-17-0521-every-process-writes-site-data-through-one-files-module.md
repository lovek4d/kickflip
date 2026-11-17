# Every process writes a board's data through one files module

A board's `data/` files had three writers with different rules (T-596 architecture review, finding 2; the owner took
option A). store.mjs replaced files by a rename of `${file}.${pid}.tmp` and merged a value read earlier under the
file's lock. The board server wrote ten files itself: `writeShown` (rename, no lock, no merge) and raw
`writeFile`/`rename` pairs on a shared `${file}.tmp`. `data/landers.json` had two unlocked read-modify-write writers
(the server's `launchLanders` and store.mjs `restartLander`). `events.jsonl` had two appends: the server's, with
7-character ids, which stepped the change signal, and the hub's fallback, with 3-character ids and no signal.

`board/files.mjs` is now the one module every process writes a board's data through: the CLI (through store.mjs), the
board server, and the hub's fallback event append in `hub/boards.mjs`.

- `readJSON` / `writeJSON(file, value, {from, told})`: a value read through `readJSON` is written under the file's lock,
  merged (merge3) with what was written since. `from` names that read when the value was built anew from it, as
  the server's `reviveHeadless` and `launchLanders` build theirs.
- `editJSON(file, edit)`: a locked read, edit and write, the lock held from the read to the rename. The server's
  `trackLaunch` and queued planners, and `restartLander`, write through it, so every run-state file
  (`headless-builders.json`, `queued-planners.json`, `landers.json`, `rebases.json`) is written under the lock.
- `replace` names its tmp file `.<name>.<uuid>.tmp`, unique per write, so two writes of one file at once in one process
  never share a tmp file. The notes file's write is a `replace` with its mode.
- `appendLine`, and `appendEvents(site, list, at)` / `appendEvent`: one event id scheme, `e` + the time in base 36 +
  five random base-36 characters, and every append tells the board (`wrote`). The server passes its clock as `at`.
- `wrote(file)` tells a board server in the same process before the write returns, so the server's own write steps its
  data version at once, as `writeShown` and the server's old append did. A file only the server's passes read
  (`triaged.json`, the pull markers, `action-pushes.json`, `idle.json`, `limbo-waits.jsonl`, `sync.json`) is written
  with `told: false`, as before.

The server registers `tellOnWrite` as soon as it holds its port, not after its startup passes, so its own writes during
startup reach `changed` directly. `changed` steps the data version at once but holds the page signal and the change
passes until the startup passes are done, so no pass reads the board half-migrated: a store write during startup
used to reach the server only as a POST its requests held until then.

This amends [agents write site data only through board.mjs](2026-10-29-1639-agents-write-site-data-only-through-board-mjs.md):
agents still write only through `board.mjs`, and every process writes through `files.mjs`. It also amends
[a store write tells its board server](2026-11-16-0312-a-store-write-tells-its-board-server.md): the hub's direct
append now tells boards as every write does.

Left out: writers outside store.mjs, the server and the hub's append (`bin/wait-events.mjs`'s `watcher.json`,
`board/arch-review.mjs`, `board/permissions.mjs`, the hub's own files through `saveJSON`) still write by themselves.
