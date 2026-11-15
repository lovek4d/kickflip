# A restart waits for the old tmux session to close before resuming

A restart of a hub board's session (the hub's automatic one, restartSession, and the Restart on the Hub page,
restartBoard) stops the session, which closes its tmux session a moment later. Resuming at once found the tmux session
still open and refused it as live, so the automatic restart logged "failed" and pushed the owner, though the session was
only slow to exit.

Both now call closeTmux (hub/sessions.mjs) after the stop: it polls `tmux has-session` every 0.5 s for up to 10 s, and
kills a tmux session still there, then the resume runs. A board that doesn't run in tmux skips the wait.

Considered: only retrying the resume on 'live'. Rejected: a session that never closes would then fail every retry,
where the kill clears it.
