# A board server holds its port before it launches anything

T-331 (#674) got two headless builders 2 s apart. The board's port, 4601, had been held since 11/13 by a board server the hub had no record of (its pid file gone), so every start the hub made died on `EADDRINUSE`, and the hub kept starting one on its crash backoff. `startServer` ran its migrations, `launchCutOffBuilds`, the pull and the other startup jobs before `server.listen`, so each of those doomed starts did a startup's work first: two of them launched T-331's builder. The record they read was a session's dispatch, with no kind, model or worktree, so each brief named the worktree null.

Three changes:

1. `startServer` listens first. A process that loses the port rejects with `EADDRINUSE` having written and launched nothing. Requests that arrive while the startup passes run wait for them, so none reads the board half-migrated.
2. `cutOffBuilds` takes only records the server dispatched itself (`dispatched` 'tap' or 'hub'). Those keep the pick's kind and model and the worktree their start made, which the launch's brief names. A session's dispatch ('session') is the session's to launch.
3. Before the hub starts a site's server, it checks the port. A process holding it that runs the site's command (a stray copy of the server) is stopped, and the start waits for the port to free, so one start follows. A port held by anything else is left alone: the hub logs who holds it and waits a backoff step, rather than starting a server that can only lose.

A lock file per board was not chosen: the port is already the one lock every copy of the server contends for, and binding it first makes it decisive.
