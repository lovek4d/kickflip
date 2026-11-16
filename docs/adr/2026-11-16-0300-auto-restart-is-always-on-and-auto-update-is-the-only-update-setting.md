# Auto restart is always on, and auto update is the only update setting

Supersedes the "One setting" bullet of [new server code waits behind a restart row and restarts itself once idle](2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md).

- **No auto restart box.** The Hub page's footer keeps `auto update` alone. `POST /_hub/settings/auto-restart`, `readAutoRestart`, `setAutoRestart` and `update.restart` in `/_hub/api/hub` are gone.
- **Restarts always run**, held as before by `auto-restarts.mjs` restartHeld while a board's session is busy, a builder, planner, helper or lander is open, or a land is queued. A restart row's tap still restarts at once.
- **A stored `autoRestart` is ignored**, and `migrateSettings` drops it from settings.json at hub start.
