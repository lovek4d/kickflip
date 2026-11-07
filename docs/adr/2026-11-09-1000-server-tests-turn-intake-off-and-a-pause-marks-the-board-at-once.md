# Server tests turn intake off, and a pause marks the board at once

The v0.6.0 release run failed twice on timing. The watcher test read an `intake-handoff` line from an earlier test's stranded intake run instead of A1's message. The Pause board test timed out waiting for the lift's `usage-resumed`: the pause checks coalesce, so a check could first run after the lift and never see the pause.

## Decision

- `KICKFLIP_INTAKE=off` makes the server's intake pass return at once. `board/server.test.mjs` sets it on its server, so earlier tests' asks launch no runs and hand nothing off. Nothing in that file asserts on intake runs.
- `POST /api/pause` with a pause marks the board paused before its Auto check, so a lift that follows wakes the session even if no check ran in between.
- The watcher test keeps its end-relative slice and drops the hedge about earlier tasks' waits.

Superseded in part by [the orchestrator sorts new tasks itself](2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md): with no intake pass, `KICKFLIP_INTAKE` is gone.
