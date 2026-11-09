# A file lock records its holder, and a gone holder loses it

`withFileLock` (hub/locks.mjs) writes the holder's pid into the lock directory. A waiter that finds the holder's process gone (`kill(pid, 0)` says ESRCH) removes the lock at once. A lock with no pid file, or whose pid is alive, still goes stale only by age (`staleAfter`).

**Why.** A board server stopped with SIGTERM (the hub's stop, or `child.kill()` in the lander test in board/headless.test.mjs) has no handler, so a stop landing inside a locked write never ran the `finally` and left the lock for 30s, longer than any writer's 10s wait. `board.mjs lander` then failed with "locked by another kickflip" under load, and in real hub restarts too (#455).

**Not done.** A SIGTERM handler in the server: the SIGKILL after the hub's KILL_AFTER would still leave the lock. A pid-reuse check: a dead holder's pid reused by an unrelated process inside the wait falls back to the age rule.
