# A reply file ends Working without waiting for its change signal

The watcher's Stop hook flagged events as "Working on it with no answer" after `board.mjs reply` had written their reply (issue #965, seen on an overnight-triage event and an item-message), and `/api/board` read the card `working: true` straight after.

The build already ends the mark when the event has a reply (`domain.mjs` `unanswered`, `threadOf`). What was stale was the board the hook read: `server.mjs` `sharedBoard` is keyed on the change counter, which a write in another process bumps by a POST to `/_claude/changed` that `files.mjs` `wrote` sends and does not wait on. A lost POST left the build before the reply until the minute's pass stepped the counter.

- **The shared build's key carries the stamp of `data/replies`.** A reply is a new file there (`<id>.md`, `<id>~2.md`), so the folder's mtime moves with it, and the next read of the board builds with the reply whether or not its signal arrived. `/api/working` and `/api/board` both read `sharedBoard`, so one key serves the hook and the page.

Considered: removing the event's entry from `data/working.json` when `reply` writes. That makes a second store write on the reply's path that a failed or reordered write could leave behind, and the mark's time is what the thread's `since` and `actedOn` comparisons read.
