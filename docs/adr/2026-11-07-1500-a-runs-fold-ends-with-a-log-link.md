# A run's fold ends with a log link; no launch message

The board no longer posts "<Planner|Builder|Lander|Visual agent|Helper …> launched on … in …" when it starts an agent (#375, owner: "We don't need the planner launched message, instead just add a "log" link at the end of the section for the agent"). The launch records the log's file name on the agent's builder record, `session.log` beside the session id and pid (`recordSession`), and `threadOf` puts it on the run's started line; the run's fold (`foldedRun` in ui-threads.js) ends its summary with a "log" link, shut or open, running or finished. The prototype round chose that place over the last line inside the fold or a line under it (question `log-link-place`).

Intake triage runs have no agent record and so no fold: their launch line stays, with its "Open the log" link (#388 decides its wording).

Superseded in part by [the orchestrator sorts new tasks itself](2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md): there are no intake triage runs.
