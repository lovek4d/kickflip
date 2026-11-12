# A planner whose process is gone closes at once

Card #580. Case: T-186's prototype planner exited after one refused command. Its record stayed open, so the card read stale, the orchestrator's round-2 brief counted it as a running planner and launched nothing, and the "ended without posting a question" line came 17 minutes late, when the orchestrator closed the record by hand.

## Decision

- **Where.** `closeGonePlanners` (`store.mjs`), run first in the server's auto pass (`runAuto`), before the board is read. Each open grill, prototype or visual record whose board-launched process (`session.pid`, checked with `launchedAgents`) is gone closes there, and the pass then reads the card without it, so a written brief for that kind launches in the same pass.
- **A clean end** closes as `builder done` does: a grill or prototype through `stopPlanner`, so `planner-unasked` lands when no question came. A visual agent closes with no line.
- **A failed end** closes through `abandonPlanner` with `planner-failed` and the error. `headless.mjs runFailure` reads the run's stream-json log: the last result event's text when it is an error, its own words when the log has no result event (killed or crashed), null when it is clean. The exit code itself is not kept, because the server may have restarted since the launch.
- A planner a session started itself (no `session.pid`) is left alone; the builder's stale reading is unchanged.
