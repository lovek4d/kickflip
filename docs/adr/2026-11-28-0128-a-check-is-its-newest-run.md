# A check is its newest run, and a refused Merge is the board's answer

A PR's head commit can carry several runs of one check: a rerun, or a workflow a label started again, leaves the failed run in the status check rollup beside the later pass. GitHub's checks view reads only the newest run of each check, and lets the merge through; the hub read every run, so its Merge refused on a failure a later run had replaced. The refusal then read "not sent" with Retry, and stayed in the browser's outbox, which sends a failed tap again on every reload: once the check went green, a reload merged the PR with no new tap.

**A check is its newest run** (`hub/pr-report.mjs` `latestRuns`). A check run is keyed on its workflow's name and its own, a status context on its context, and the newest is the latest `startedAt`; a run not yet started (a queued rerun) is newest of all. The GraphQL query asks for each run's `startedAt` and `checkSuite.workflowRun.workflow.name` and each status's `createdAt`, and `fetchPRs` puts them in the shape `gh pr view` gives (`startedAt`, `workflowName`), so the hub's poll and the Merge's REST read judge a rollup alike.

**Every reader of the rollup reads it one way.** `reportOf` (its `failing`, which red CI's fix runs and the Merge read, and its `pending`), `checksOf` (the board's badge) and `checksPassed` (auto-ready and auto-merge) all read the newest runs, and a failure is a conclusion or state of FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED or STARTUP_FAILURE everywhere. Before, the Merge let a timed-out or cancelled check through, and didn't count a pending status context as pending.

**A refused Merge tap answers 409** (`board/server.mjs` `applyTap`). Whatever `mergeCard` refuses on a tap is the board's answer, the reason in the card's thread as before: the outbox drops a 409 and toasts the reason, as it does for a tap on a card that moved, so it never reads "not sent" and is never sent again. `board.mjs merge` on the command line is unchanged.

## Considered

- **Key a check on its name alone.** Rejected: the same job name in two workflows is two checks, and a failure in one would hide behind a pass in the other.
- **Keep a failed Merge in the outbox, and stop the reload resending it.** Rejected: a Merge refusal isn't a failed send, and Retry would only ask again what the board already answered.
