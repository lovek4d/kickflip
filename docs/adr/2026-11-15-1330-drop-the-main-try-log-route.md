# Drop GET /api/try/main/log

docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md put main's failing-try log on the board's sync and left `GET /api/try/main/log` in place with no reader on the page. The route is gone, with its entry in the hub's share allowlist (`hub/share.mjs`) and its tests. A shared view now reads main's log only as `main.log` on the board. `tryLogTail` stays: the board's snapshot and the prototypes route use it.
