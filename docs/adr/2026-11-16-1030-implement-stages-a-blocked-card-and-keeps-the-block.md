# Implement stages a blocked card and keeps the block

This supersedes [a held Todo card shows Build in place of Unhold](2026-11-03-0234-a-held-todo-card-shows-build-in-place-of-unhold.md), whose Implement tap on an owner-blocked card cleared the block first.

The owner on T-440, held until 11/18 and tapped Implement: "Implement should not unblock anymore".

- An Implement tap or message on a blocked Todo card (the owner's block, a `--pick-up-at` hold, or a block by a task) stages it and leaves the block. `stageImplement` in `board/store.mjs` writes no `card-hold` resume and no "Unblocked" line; the card reads staged with its block words.
- When the block ends the card waits on the orchestrator's re-check as a ready card whose block ended does.
- Only the Unblock tap, or the block ending, lifts a block.
