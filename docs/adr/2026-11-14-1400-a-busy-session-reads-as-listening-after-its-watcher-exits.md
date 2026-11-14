# A busy session reads as listening after its watcher exits

The watcher exits on every event so the session wakes, and the page counted a board as listening for only 2 minutes after an exit. A session turn longer than that (a land check, an investigation) read "not listening" though the session was alive and handling what woke it. Reminders for held waits woke the watcher every 1–5 minutes, so the board read deaf much of the time.

Three changes:

- **One reminder clock.** `waitsStep` puts every "again" reminder on one board-wide clock (`againAt` in `data/orchestrator-waits.json`). At most one `orchestrator-waits` event with `again` is written per 15 minutes, and it carries every wait due by then. A wait that falls due inside the window stays due and goes out with the next reminder. A new wait ("added") still wakes at once.
- **A bounded busy rule.** After a watcher's exit, `watcherRunning` reads listening while the owner session's record (`~/.claude/sessions`) says `busy` with `statusUpdatedAt` at or after `exited_at`, and for at most 20 minutes after the exit. Past that the board reads not listening and the deaf push fires as before. The 2-minute relaunch grace still covers an idle session. The limit is there because a session stuck busy (a permission prompt, a rate limit) must not read listening forever, and `status` is an undocumented Claude Code field, so it only ever adds listening time, never keeps a board listening without bound.
- **Exit time on a signal.** `bin/wait-events.mjs` writes `exited_at` on SIGTERM and SIGINT too, then ends by the same signal. Before, only a normal exit wrote it, and a killed watcher showed no grace at all.

A streaming watcher under Monitor was considered and dropped: a kill reads deaf at once, a kill mid-batch duplicates or loses events, and it rests on unverified behaviour (the parent chain `sessionGone` needs, whether an expiry wakes an idle session, whether `--bg` sessions have Monitor).
