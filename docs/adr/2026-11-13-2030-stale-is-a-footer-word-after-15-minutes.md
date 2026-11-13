# Stale is a footer word after 15 minutes, and quiet is gone

Card #646. The owner (11/13): "Do we mark stale after 5min? Maybe should increase to 15 min. And stale should not change the color of the live status line and progress bar, just add the footer word", then "Just drop the quiet entirely, let's simplify to stale."

## Decision

- **One silence reading, stale, at 15 minutes.** `BUILDER_STALE_AFTER` is 15 minutes of no progress line and no transcript movement for a run the board doesn't track. A run whose headless process is gone is stale at once, and still reads "stopped" on its line, as before. A live process is never stale.
- **Quiet is removed.** `BUILDER_QUIET_AFTER`, `builder.quiet` and the `.sub.agent.quiet` styling are gone, with the running-command signal (`transcriptCommandRunning`, the snapshot's `commandRunning`) that only kept a quiet build blue. A build asked to pause no longer drops its dot or greys its line; the footer's pause words and its dimmed bars once paused are what mark it.
- **Stale shows only in the footer.** A stale build's status line keeps its lane colour and dot, and its phase bars are not dimmed; the grey "stale" word after the time (`ui-cards.js timeLine`) is the whole mark. This replaces the grey line of [stale is automatic, stalled is the orchestrator's flag](2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md) and the quiet reading of [a card's status word comes from a signal the board checks](2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md) and [a running command keeps a build line blue](2026-11-05-1403-a-running-command-keeps-a-build-line-blue.md); stalled, the orchestrator's flag, is unchanged.

## Considered

- Keeping quiet at 15 minutes beside stale: with no footer word of its own, it showed nothing the owner could read.
