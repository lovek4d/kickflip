# A blocked card owes the owner nothing

A blocked card (the owner's block, a blocked-until condition or an unfinished dep) has no action: no Tap Implement, Tap Done or draft-review nudge, so no Action needed and no needs-you push. Open questions, a stalled card and an offered script still show, since the owner can answer them while the card waits.

Its staging wait goes too: the orchestrator can do nothing for a blocked staged card, and the wait opens when the block ends.

"blocked" and "blocked until …" are orange like "blocked by": a block is attention, not idle. The colour rule (AGENTS.md, CONTEXT.md) moves blocked from grey to orange; grey keeps idle and paused.

## Amended: a blocked card still owes Implement and Done

Card #1148: T-807, blocked by T-806, lost Action needed and read its phase, so the owner couldn't approve it ahead of
its block. A blocked card owing Implement keeps Tap Implement, and one owing Done keeps Tap Done, with Action needed.
Its Implement stages it as usual, and its staging wait stays open while it is blocked: the orchestrator readies it
with the block kept (`item set --phase ready` works on a blocked card), and the pull waits for the block.

The draft-review and manual-steps nudges stay suppressed, since their work can't start, and so do the limbo and
past-Todo unblocked waits. The rest of this decision stands: the block words are orange, and a blocked In Review
card's Merge shows disabled.

The amendment above is superseded by [a block holds every transition, and its end moves the card or opens a wait](2026-11-24-0100-a-block-holds-every-transition-and-its-end-moves-the-card-or-opens-a-wait.md): `item set --phase ready` refuses a blocked card, blocking a ready card sends it back to staging, and its staging wait drops while it is blocked, returning at the block's end.
