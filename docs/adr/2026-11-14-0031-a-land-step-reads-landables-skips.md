# A land step reads landable's skips

Follows docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md. That change made landStep the one decision that launchLanders and both lines read. But domain.mjs worked out a verified card's step from its records and data/landers.json alone, not from store.mjs `landable`. A card landable skips (blocked, a question open, or its worktree gone) still read "Lander starting" on its status line and "The board launches a lander within a minute" as the orchestrator's wait, and the server never launched one.

T-265 showed a second gap. Its verification was lost when its lander's `builder start` replaced the verified record. Its build had no calls, so `builder verified` refused ("no unverified judgment calls"), `board.mjs lander` refused (no open record, no entry), and nothing put it back where landStep could see it.

## Decision

- **landable lists every verified card that waits to land, each with its skip.** The skip is `{step: 'worktree-gone'}`, else `{step: 'blocked', blocked: <blockWords>}`, else `{step: 'asking'}` while a question on the card is open, else null. A gone worktree comes first because it is red: the orchestrator has to act on it, and a block or a question can't hide it.
- **landStep takes the skip as its own step.** The order is running, fault, skip, held, launch. A lander already running keeps running, and a fault stays a fault. A skip goes ahead of a hold, since a hold clears on its own and a skip doesn't.
- **The snapshot carries `landSkips {<key>: skip}`** from the same landable read. domain.mjs passes it to landStep as launchLanders does, so the lines and the launcher read one verdict. The read is skipped when no record on the board is verified.
- **Words.** blocked: "Landing blocked by #12" (grey), with the wait saying the board launches a lander once nothing blocks it. asking: "Landing waits on its open question" (grey). worktree-gone: "Lander can't start: its worktree is gone" (red), with a `stale` wait that tells the orchestrator to restore the worktree from its branch or stall the card.
- **`builder verified` marks a handed-back build with no calls**, the same way `builder done` with no calls finishes. It is the way back for a build that lost its verification. It still refuses an open record, and a record whose calls are all verified already.

## Consequences

- T-265 gets its lander from `board.mjs builder verified hub/T-265`, run once this lands. Verifying tries the land itself (finishCard). If that stops on its conflict, the record stays verified and the next launchLanders pass launches the lander.
- A verified card with no worktree is now a stale wait on the orchestrator. Before this change it read "Lander starting" indefinitely.
