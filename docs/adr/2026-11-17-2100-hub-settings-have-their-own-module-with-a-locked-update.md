# Hub settings have their own module with a locked update

`~/.claude/kickflip/settings.json` was read and written through hub/push.mjs, whose job is Web Push. Each writer read the
whole file, changed a key and replaced the file with no lock, so a board's pause and a hub rules edit made at once could
drop one of the two. Adding a hub setting meant editing push.mjs.

## Decision

- `shared/hub-settings.mjs` owns the file: `settingsFile()`, `read()`, and `update(change)`, which holds hub/locks.mjs
  `withFileLock` across the read, the change and the write. Every per-key accessor (Codex, Auto update, land tests, Builders,
  Orchestrators) lives there; push.mjs keeps only Web Push, and its quiet-hours and notifications writes go through `update`.
- Every setter is async because the lock is. Callers await it; a setter that refuses a value rejects with the same `status`.
- store.mjs takes the path from `settingsFile()` instead of building it.
- `repickDaemon` (shared/tailscale.mjs) is sync and many callers read its answer at once, so it writes through `updateSync`,
  which takes the same lock directory as `withFileLock` (hub/locks.mjs `withFileLockSync`) and waits by blocking the thread.
