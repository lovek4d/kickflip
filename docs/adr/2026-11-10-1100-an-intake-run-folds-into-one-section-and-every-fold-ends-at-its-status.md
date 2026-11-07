# An intake run folds into one section, and every fold ends at its status

Owner, #404: the intake hand-off line should not also pass the reason, and intake triage gets a collapsed section like planners and builders; every collapsed section reads `<action> · <status>` with nothing after (running, finished, handed off).

- An intake triage run's thread lines carry `intake: {event, agent, end?}`; `threadOf` gives them `run: intake:<event>`, so `foldStatus` folds the launch line and the closing line into one section. This supersedes "Intake triage runs have no agent record and so no fold" in 2026-11-07-1500-a-runs-fold-ends-with-a-log-link.md.
- The hand-off line (`intakeHandoff`) reads "Intake triage handed this to the orchestrator" with no reason and ends the fold `handed off`. The reason stays in the `intake-handoff` event's `text`, which the orchestrator's intake wait reads (so #384's "timed out after <limit>" no longer shows in the thread, only there).
- A run that ends with its event sorted gets a closing line, "Intake triage finished", from the server's intake pass (`data/intake-runs.json` `folds`, `closed`); runs launched before this have no `folds` and get none.
- `foldedRun` summaries drop the newest status text and the trailing "log" link; the log is an "Open the log" link at the end of the open section. Only finished is green, the rest keep #397's colours.
