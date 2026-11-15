# An Implement tap stops the card's planners and stages it

An Implement tap wins over whatever is in flight on the card. T-154 sat "stuck in prototyping" after two taps: its round-2 prototype question was skipped by the tap, but the owner's round-2 request stayed the chain's newest input, so `noTakePicked` kept the card unpicked and the pull never took it.

- `stageImplement` (also the bare tap's `implementAsIs`) first ends the card's planners (store.mjs `endPlanners`): each open grill, prototype or visual record closes with the note "Stopped by your Implement tap", a stop and not a fault, and the board server stops the process (`stopAgents`).
- Its staged and screening questions and its briefs are dropped, so nothing launches a planner after the tap.
- Every question not yet resolved, open, requested or answered, resolves "Skipped: you tapped Implement" (domain.mjs `IMPLEMENT_SKIPPED`).
- `noTakePicked` drops a chain's inputs older than such a skip, so the card is buildable at once. A request made after the tap is newer than the skip and prototypes again.
- The card then reads staging, as before, for the orchestrator to fold and ready.
