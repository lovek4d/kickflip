# A builder hands back with a summary message

The `builder done` that ends a build (the main record, not a lander's, rebase run's, planner's or install's, handing back its judgment calls or finishing the worktree it keeps; no `--next`) refuses without `--summary "<what you built, in a few plain sentences: what changed for the owner, and what you left out>"`. Any other done refuses a summary. The summary is kept on the builder record, and on its past-run copy once a lander starts over it, and the thread shows it, once the record is done, as a message headed **Builder** at the build's finish, directly above its judgment calls. `--text` stays the short "what you checked" closing line of a finish.

Thread messages are named by who wrote them: **Orchestrator** (orange tint) for the board's session, **Builder** for a builder's summary and its asks, the owner's as theirs. Grey is every voice that is neither the owner's nor the orchestrator's: a builder, a teammate's copied Slack reply and any other sender share the one grey tint, and the header says which.

## Why

Before this, all a builder left in the thread was its "what you checked" line and its calls; what it built lived only in the commit and the orchestrator's verify note, so the owner reading the thread had no plain account of the build.

## Considered

- **A thread line written at done.** Rejected: a finish that fails (tests, conflicts) runs done again, which would post the summary twice. On the record, a second done replaces it, and the thread places it at the record's finish, the same moment its calls entry sits at.
- **Folding `--text` into the summary.** Kept apart: `--text` is the finish's one-line status (also a rebase run's and a lander's), the summary is the owner's account, and the runs that don't build (lander, rebase run, helper, planner, install) owe none.
- **Builder asks keep their model's name** ("Claude Opus builder"). Replaced by Builder: the header names the role, as Orchestrator does; the model shows on the run's own lines.
