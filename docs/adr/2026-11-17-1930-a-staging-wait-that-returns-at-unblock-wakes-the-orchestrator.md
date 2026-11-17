# A staging wait that returns at its card's unblock wakes the orchestrator

A staging wait drops off the list while its card is blocked and comes back, with the same `since`, when the block ends.
It came back still carrying the pickup from before the block, and `waitsStep` opens a picked wait without waking anyone,
so it waited for the hourly re-wake.

A card in staging now records `unblocked_at` when its block ends (store.mjs `markUnblocked`), as a card past Todo does.
`orchestratorWaitsOf` ignores a staging pickup older than `unblocked_at`, so the returning wait opens unpicked and wakes
the orchestrator at once. A pickup after the unblock stands. Other wait kinds are unchanged.

A shorter staging reminder is not needed for this case.

Superseded by [a wait a block held is owed from the block's end](2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md), which applies the void to every wait a block holds.
