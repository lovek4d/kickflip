# A wrong wait gets a fix task, never a filter

The orchestrator carried "ignore the stale wait brief T-566" for two days: a done card still owed a prototype brief. Filtering a waits line hides the next real wait that looks like it, and the board never gets fixed.

Decision: the orchestrator reads every waits line the watcher prints. A wait that is wrong (owed by a done card, already answered, impossible to clear) is a board bug: file a fix task the same turn, naming the wait and why it is wrong. T-823 fixed the T-566 case.
