# No sweep for owner events that never got a reply; the watcher is trusted

Owner events wake the session through the background watcher. After it dropped one answer for 16 hours, we fixed the cause: the watcher now keeps a cursor.

Considered options:
- a monitor tick that sweeps for unreplied events every 30 minutes;
- the same sweep plus a "No reply after 1 h" chip on the page;
- trusting the watcher.

The owner chose to trust the watcher (round `site-v6`). The session relaunches the watcher after every event.
