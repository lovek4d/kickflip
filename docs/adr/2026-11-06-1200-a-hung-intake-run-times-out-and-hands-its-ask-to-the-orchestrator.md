# A hung intake run times out and hands its ask to the orchestrator

Intake runs one at a time per board, so one hung Sonnet run left every new ask unsorted behind it, reading New, with nothing waking the orchestrator.

A run still open `INTAKE_TIMEOUT_AFTER` (10 minutes, `BUILDER_STALLED_AFTER`'s figure) after its launch time `at` in data/intake-runs.json counts as hung, whatever it is doing. `intakeHung` (domain.mjs) names it; the server's pass (`runIntake`) sends SIGTERM to its process group, SIGKILL after 5s, marks it ended with `timedOut`, and hands its event to the orchestrator through `intakeHandoff` as an `intake` wait with the text "the intake triage run timed out after 10 minutes". The same pass then launches the next due event. There is no relaunch. `at` is on disk, so the limit holds across a server restart.

Rejected: 5 minutes of log silence, or either that or a longer total (no intake run has been timed on a real board, so a fixed limit is the simpler claim); stop and relaunch once; hand off without stopping (the hung run would keep holding the queue).
