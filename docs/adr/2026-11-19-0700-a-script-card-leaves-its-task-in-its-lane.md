# A script card leaves its task in its lane

A task with a script offer waiting on the owner's Run or Decline used to move to In Review (placeOwnerWait treated the script action like any owner-only action). A Todo task offered a script left Todo with no builder having started anything.

Now the waiting script is only the task's Action needed (kind `script`, "Run or decline the script", pushed at once as before). The task stays in the lane it was in, as a stalled task does. Running or declining the script clears the mark; the script's result is a `script` wait on the orchestrator, not a lane move.

The notes asked for red; Action needed is orange by the Colour rule (red is for faults), as the first script ADR already settled, so the colour is unchanged.
