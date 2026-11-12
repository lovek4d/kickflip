# A ps with no answer closes no planner

closeGonePlanners closes a planner's record when its process is gone. launchedAgents reads a null ps answer (a timeout
on a loaded Mac) as "no processes", so a running grill or prototype read as gone and was closed.

Decision: a null ps answer means unknown. `agentMayRun` (headless.mjs) is true when ps gave no answer, and the gone
check uses it; only a ps answer that lists processes without the pid closes the record. launchedAgents itself is
unchanged: stopping an agent on no answer signals nothing either way.
