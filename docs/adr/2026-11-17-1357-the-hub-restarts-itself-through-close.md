# The hub restarts itself through close()

The hub's own restart, for new code (`hub/self-restart.mjs`, a pulled HEAD or a finished `kickflip update
--no-restart`) or the hub page's Restart hub, ran `launchctl kickstart -k` (systemd: `systemctl --user restart`) from
inside the hub with `spawnSync`. The hub's event loop was blocked in that call while the service manager stopped the
hub, so its SIGTERM handler never ran: no "hub stopping; stopping sites" line after 11/15 22:25Z across dozens of
restarts, each new hub logging "stopped stale <route>" for the board servers the old one left, and in-flight web
pushes, Slack posts and board server sends cut mid-way (T-635, finding 2).

Now the hub restarts itself by stopping as a SIGTERM stops it, `shutdown()` in `hub/hub.mjs`:

- `close()` runs: the clocks stop, each board server gets SIGTERM and finishes its passes and requests before it exits
  (board/server.mjs close(), killed only past `KILL_AFTER`, 5 s), the try runs stop, and the hub's own passes in
  flight (polls with their Slack sends and pushes, reconciles, checks) settle before the server closes.
- The wait is bounded by `STOP_WITHIN` (6 s), then the process exits 0.
- The service that keeps the hub running starts it again on that exit: launchd's `KeepAlive` and systemd's
  `Restart=always` both restart a clean exit. Nothing in the hub calls the service manager to restart itself.
- On a host with no service manager an exit would stop the hub for good, so the restart refuses there, logging the
  service's reason, as before.

`hubService().restart()` (`launchctl kickstart -k`) stays for a restart from another process (`kickflip update`,
`kickflip restart`): there the hub's event loop is free, so the manager's SIGTERM runs the same `shutdown()`.

`board/worktree.mjs` `restartRunner` and its `KICKFLIP_RESTART_CMD` stand-in had no other caller and are gone; a hub
test passes `startHub({exit})` instead.

Supersedes the restart step of docs/adr/2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md.
