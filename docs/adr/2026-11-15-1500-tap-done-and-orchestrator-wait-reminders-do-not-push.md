# Tap Done and orchestrator-wait reminders do not push

Card #782 (T-397), slice 2 of T-190 from the owner: drop the Tap Done pushes and the wait-reminder pushes, "instead have that bump the orchestrator". The idle push stays.

## Decision

- **Tap Done is not in the board's row.** `ownerActions` skips a card whose action is Done, so the live notification neither pushes for it nor counts it ("N to close" is gone from `ROW_PARTS`). The card still shows its Done button on the board.
- **A wait never pushes the owner.** `checkWaits` no longer sends the 30-minute `wait-<key>` reminder, and `ORCHESTRATOR_PUSH_AFTER` and the `pushed` mark on a stored wait are gone. A wait is the orchestrator's to act on, not the owner's: the re-wake (`waitsStep`, 15 minutes on from the last wake) is the reminder, and the watcher prints it.
- **The idle push is unchanged.**

Supersedes the line in [a board's needs-you pushes are one live row](2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md) that left these two to T-397.
