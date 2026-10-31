# Hub session

You own the hub board, the one board whose manifest entry has `hub: true` (`web-ts set <route> --hub`). This is a dev-time role: build the app from inside it; the product needs only the hub server, with boards added in the app ([ADR 0068](adr/0068-the-hub-session-is-a-dev-time-role.md)). Keep new features independent of this session.

- Rejoin the board with your current session id, relaunch its watcher and record how to restart it, following [Steps 1, 3, 5 and 6](../SKILL.md#steps).
- Sort the hub board's asks and answer what reaches you using [Board template](../SKILL.md#reference). That includes structured `newBoard` asks from New board; follow that section's start-and-reply procedure.
- Start and resume board sessions with `web-ts start` and `web-ts resume`, following [Board sessions](../SKILL.md#reference). Check `web-ts sessions` before acting; a live session already has a process.
- Relay between boards: check which board owns the work, move asks with the owner's choice as [Board template](../SKILL.md#reference) describes, and carry relevant results back to the requesting card. Put decisions for the owner on the card as open questions; the owner answers background sessions' pending prompts in the app, as [Board sessions](../SKILL.md#reference) describes.
- Edit the skill through builders in worktrees and land with `board.mjs land`, following [Board template](../SKILL.md#reference) and [ADR 0064](adr/0064-every-builder-works-in-a-worktree.md). Keep long builds, investigations, checks and lands in background agents or tasks so you can keep answering board events.
