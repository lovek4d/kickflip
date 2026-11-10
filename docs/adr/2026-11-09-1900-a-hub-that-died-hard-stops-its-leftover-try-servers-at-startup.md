# A hub that died hard stops its leftover try servers at startup

Each build script runs in its own process group (`launch` spawns it `detached`), and a hub that dies hard, or exits at `KILL_AFTER` before `stopTries` finishes, leaves those groups running.

- try.json keeps a top-level `groups` list: one `{pgid, key, worktree, port?}` per live run, added when the script is spawned, given its port when it prints one, and dropped when the run's group has ended. It is absent when empty. A per-entry pgid would have waited on the Main entry's shape; a list doesn't touch it.
- `initialize` sweeps each board's list before anything relaunches: a recorded group still up is stopped (SIGTERM, SIGKILL after 4 s, as `terminate` does) only when some member's cwd or command is inside the run's worktree, so a reused pgid that now belongs to something else is left alone. hub.log gets `stopped leftover try /<route> <key> (pgid N)`.
- After any stop (a run's end or the sweep) the run's port is probed; one that still answers means a server left the group, which a sweep can't catch. A card gets a red `run-failed` line naming the port; Main and the prototype serve log it. A stopping hub skips the probe.
