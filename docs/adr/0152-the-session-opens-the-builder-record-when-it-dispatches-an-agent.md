---
status: superseded in part by ADR-0174
---
# The session opens the builder record when it dispatches an agent

Superseded in part by [0174](0174-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md): the record is marked `dispatched: 'session'`, and a dispatch on a record the tap opened changes nothing.

This extends [0139](0139-a-build-tap-starts-the-build-in-the-board-server.md), whose take-over of a `tapped` record now covers any dispatch, and [0137](0137-a-builder-status-line-is-a-phase-and-a-short-detail.md), whose "Starting" now begins at launch.

The session writes the brief and launches the agent, and the agent then spins up and runs its own `builder start`: about 30 seconds on kickflip.sh #1 when the card showed nothing. `builder start` already opens a record when the session runs it, so no new command: `builder start <key> --dispatch --kind <build|claude|codex|prototype|grill> [--model …] [--worktree]` opens the record marked `dispatched`, and the session runs it right before launching any builder agent, of every kind.

- **The agent takes it up.** Its own `builder start` on an open `dispatched` record behaves as on a `tapped` one: `--kind build` keeps the record's kind, a Claude record keeps its model unless the agent names one, the worktree stays, and the record starts again at now, no longer dispatched. For a prototype or grill the kind is the agent's own, and the worktree, when the dispatch made one, stays.
- **The card reads "Starting"** until the agent's first status line. A dispatched record is not `tapped`, so it never reads "Waiting for orchestrator", which means the board started it.
- **A session never posts "a builder is working"** itself: the builder line is that statement and exists only once the record does.

Considered:
- a separate `builder dispatch` command: it would write the same record `builder start` writes, so the take-over would need two ways to find it;
- a status line written at dispatch: the thread would show progress no builder made, and Stalled would count from it.
