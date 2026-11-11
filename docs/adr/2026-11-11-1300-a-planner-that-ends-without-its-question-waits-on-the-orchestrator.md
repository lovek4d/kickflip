# A planner that ends without its question waits on the orchestrator

Card #521, split from #504. Case: T-74's prototype planner ended with its question post failed and denied, and the board showed nothing waiting. Owner's answers: the wait holds until the card's state changes; the fault line reads "Its <kind> planner ended without posting a question, so it waits on the orchestrator."; ticket yes; no prototype round.

## Decision

- **Only a planner's `builder done` checks.** `store.stopPlanner` (called from `builderDone`'s planner branch) stops the run, then looks. Board close and the stop hook call `stopBuilder` and leave no fault.
- **The test.** The card is still in the planner's phase (`grilling` for a grill, `prototyping` for a prototype), with no open owner question, and nothing staged for it. A grill's questions stay staged for screening, so that one check covers both kinds. It runs after `publishStaged`.
- **The line.** `planner-unasked` in `hub-lines.mjs`: red, unread, freshens the push; its detail is the planner's kind. `builder done` prints its words.
- **The wait.** `orchestratorWaitOf` reads the newest line as an `unasked` wait while the card's stored phase still matches the kind and no planner of that kind is running or has started since. A question (the asking branch ahead of it), a running or restarted planner, or a new phase clears it.

## Not done

- A planner that exits without `builder done` is the broader audit's (T-86).
