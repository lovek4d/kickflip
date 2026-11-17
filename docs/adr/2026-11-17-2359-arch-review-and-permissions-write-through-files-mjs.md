# Arch-review records and permissions write through files.mjs; the watcher and hub files stay

board/arch-review.mjs writes its review record with `editJSON` (locked from read to rename, so two reviews started at
once both survive, where the old fixed `.tmp` name let them share a file) and its review's item file with `writeJSON`.
board/permissions.mjs drops its own tmp-and-rename writer for files.mjs's `writeJSON`, so the refusals file in a
board's data/ is signalled to the board server like every other write. The hub's raw events.jsonl append had already
moved to `appendEvent`.

Left out, on purpose:

- hub/boards.mjs `saveJSON` stays. It is synchronous, and its callers are hub features that write hub files (state,
  cursors, handshakes, the manifest under its own lock), none of which a board shows. files.mjs is async and imports
  hub/boards.mjs, so boards.mjs importing it would be a cycle. Its tmp name is already unique per write.
- The login item file in hub/boards.mjs is a launchd/systemd file, not site data.
- bin/wait-events.mjs keeps its own `writeAtomic` for watcher.json, the cursor and the shown file. They are the
  watcher's own markers that no board shows, and moving them makes the watcher's signal-exit path async. Left for the
  owner to decide.
