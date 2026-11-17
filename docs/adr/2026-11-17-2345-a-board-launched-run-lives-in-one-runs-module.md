# A board-launched run lives in one runs module

A board-launched agent run (a builder, a planner, a visual agent or reviewer, a helper, a lander, a rebase run) was
spread across the board server's launch passes, store.mjs's record openers and closers, headless.mjs's relaunch rule and
two `stopBuilder`s: store.mjs's closed a record, stop.mjs's killed the process and closed it. The lander, rebase and
builder relaunch rules lived in the server, so a run's lifecycle could only be tested through a running server (T-624).

board/runs.mjs now owns a run from start to finish:

- `start(site, key, kind, io)` opens the record and launches the agent (a build, a helper, a visual agent or reviewer
  beside the card's other agents, or a planner); `resume(site, key, io)` relaunches the run a Block stopped.
- `stop(site, key, {kill})`: without kill it closes the record (the stop hook, a Done); with kill it stops the
  board-launched process, marks it stopped so nothing relaunches it, and closes the record (`builder stop`).
- `finish(site, key, flags)` is `builder done`'s close: a helper's result, a planner's or a builder's next step.
- `alive(site)` reads each tracked run as live, stopped or held, for the snapshot.
- `tick(site, built, io, {resumes, helpers})` is the server's launch passes in one call, in order: queued planners,
  briefs, landers, rebases, resumes, reruns and helpers. A pass held by the usage gate or a busy Mac stops the rest.
- `revive(site, read, io, {boot})` is the minute's relaunch: cut-off builds at boot, then gone builders (relaunched
  once, handed back the second time) and lost launches.

`io` carries the launcher (still injected as `startServer({launch})`), the audit log, the hook that drops the server's
cached board, and the event writer. The run-state files (headless-builders.json, landers.json, rebases.json,
queued-planners.json) are read and written only through runs.mjs; snapshot.mjs reads them through `alive`,
`readLanders` and `queuedPlanners`.

runs.test.mjs drives a build's and a lander's lifecycle with a fake launcher that spawns idle processes, with no server.

## Left where it was

- The record openers and closers (`startTappedBuild`, `startPlanner`, `closeRecord`, `stopPlanner`, `landable`, …) stay
  in store.mjs: they share the card and question helpers a later card moves out of store. Callers outside runs.mjs
  reach a run through runs.mjs.
- The pause pass (`checkPauses`, which stops a run when its card's hold starts) stays in the server and runs before
  `tick`; it hands `tick` the cards to resume.
- `tick` runs on each Auto check, `revive` each minute, so they are two calls rather than one.
