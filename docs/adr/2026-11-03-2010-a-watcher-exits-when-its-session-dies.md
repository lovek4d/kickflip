# A watcher exits when its session dies, and a new one stops the old

A board's session runs `bin/wait-events.mjs` as a background task: Claude Code runs a shell, and the shell runs the watcher. When the session dies, the shell is reparented to launchd and the watcher keeps running. It reads the same `.watch-cursor-<session>.json` as the watcher the resumed session starts, so the two race for the next event, and whichever wins may hand it to nobody.

**The watcher notices its session is gone.** At start it records its parent (the shell) and that shell's parent (the session's process). `sessionGone` in `hub/live.mjs` reads the session as gone when the watcher's parent changed, the shell's parent changed (the session died and the shell went to launchd, which also catches a resumed session that kept the same id), or the session isn't in `liveSessions`. The watcher checks on each wake and again just before it prints, and exits with no output, its events and cursor untouched, for the next watcher.

**A ps that gives no answer leaves the session's liveness unknown, never gone.** Each check asks `ps`, which on a heavily loaded Mac can take past its 3 s timeout. A check `ps` gives no answer for (`parentOf` returns undefined, `liveSessions` null) doesn't count, so the watcher keeps waiting and checks again on its next wake; a grandparent unknown at start is read again then. The watcher asks `liveSessions` about its own session only, so `ps` is asked about one pid, and `processStarts` drops pids that `kill -0` already shows gone. Every other reader of `liveSessions` handles unknown too: start, resume, stop and `kickflip hub` refuse (`SessionError` reason `unknown`), the hub's wake, deaf push, compact and link-fault checks skip that round, `listenState` trusts a running watcher and otherwise reads asleep, and `kickflip sessions` prints `live unknown`.

**A new watcher stops the old one.** Before it records itself in `data/watcher.json`, a watcher calls `stopPreviousWatcher` in `hub/boards.mjs`, which sends SIGTERM to the recorded pid only when that record has no `exited_at` and the pid's command line is `wait-events.mjs <route> <session>` for the same route and session. A record with `exited_at` is a watcher that exited on an event; its pid may since be anything's, so it is left alone. SIGTERM ends the old one without its exit handler, so it can't write its exit time over the new watcher's record.

Tests that run the watcher record the test process as the session's live Claude process (`ownSession` in `shared/test-helpers.mjs`).

Considered:
- raising ps's timeout: a load that delays ps 3 s can delay it longer, and a watcher that exits on a slow ps still leaves the board not listening.
- requiring the session's recorded pid to be an ancestor of the watcher: stricter, but every caller that runs a watcher from somewhere other than the session's own shell would be read as orphaned at once. Watching for the parent chain to change catches the same death.
- only the new watcher stopping the old: a watcher whose session died and wasn't resumed would still take events and mark them working for no one.
