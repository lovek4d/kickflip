# Concurrent board writes merge instead of overwrite

A board's JSON files (wave.json, owner.json, agents/*.json) are changed by read-modify-write from many processes: the CLI, headless builders, landers and the server. Renaming a temp file over the target is atomic but did not stop two writers that read the same version: the later rename dropped the earlier change (#221 stayed `building` after it landed).

Decision: `readJSON` tags an object with the text it read, and `writeJSON` takes the file's lock (`hub/locks.mjs`), merges the writer's change since that read into the file as it now stands (`board/merge3.mjs`), and renames. Arrays of `{id}` objects merge per id; where both sides changed the same value, the writer wins.

Why not hold a lock across each command: builder commands run for minutes (rebase, full suite), and ~70 write sites would each need wrapping. The lock here lasts only the merge and rename, and covers every writer that writes a value it read.

A value built without readJSON (a fresh `{events: …}` record) is written whole, as before.
