# The working build reads the stamps of acted-on, working and delivered

The watcher's Stop hook flagged a thread message as unanswered, or as unread, for up to a minute after the orchestrator had answered or read it (issue #1226), the gap between the minute's passes.

`/api/working` reads `sharedBoard`, which is keyed on the change counter and the stamp of `data/replies` (docs/adr/2026-11-18-2000-a-reply-file-ends-working-without-waiting-for-its-signal.md). A thread line is read by `threadOf` against `data/acted-on.json`, and an unread message by `data/working.json` and `data/delivered.json`; each is written by another process, whose POST to `/_claude/changed` (`files.mjs` `wrote`) is not waited on. A lost POST left the build before the write.

- **The shared build's key also carries the stamps of `acted-on.json`, `working.json` and `delivered.json`.** `writeJSON` replaces each by rename, so its mtime moves with every write, and the next read builds with it whether or not its signal arrived.

Considered: stamping `data/threads`. An append to a thread file does not move the folder's mtime, so the key would not move.
