# A clean visual end with no page reads unplaced; a usage-limit planner relaunches

A visual agent's job is one page on the card's thread. When its record closes, by its own `builder done` or because its process is gone (closeGonePlanners), a `visual` thread line since the record started is its page. With none, the card gets the red `visual-unplaced` line, and a `visual` wait on the orchestrator that a later page or a newer visual agent clears. No relaunch: a visual faults at once, as a planner does (T-86).

A grill, prototype or visual agent whose run log ends on the usage limit (hub/usage.mjs runLimit) is not a fault. Its record closes with no line and its brief goes into data/queued-planners.json with the limit's reset (`until`). launchQueuedPlanners leaves it until the reset passes, then relaunches a planner, or puts a visual's brief back on the card for the next brief pass.

The limit check runs before the failure check, since a limit stop is also an error result.
