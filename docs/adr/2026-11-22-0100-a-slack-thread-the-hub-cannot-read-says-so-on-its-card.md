# A Slack thread the hub can't read says so on its card

#1125: a teammate's reply in a Slack-filed task's thread, written while the task was open, never reached it.

- **`ends` is not the cause.** `slack-threads.json`'s `ends` marks each thread seen while its task was open so its end line posts once (ADR 2026-11-16-1700). `followedSlackThreads` never reads it; a thread in `ends` is copied exactly as before. A test now keeps T-122's shape (owner reply copied, orchestrator reply posted, asker's later reply) and the reply lands.
- **What could still lose a reply silently.** A thread read that fails (Slack error, a message that can't be written) was only logged, at most hourly, and the same message was retried while the card showed nothing. The owner's cards read as listening.
- **The fix.** The first failed read of a thread writes one red `slack-follow-failed` line on the card; `slack-threads.json`'s `follows` records the thread as failing so it isn't written again each poll. The thread is read again every poll, and a successful read clears the mark, so a later failure says so anew.
- **Not changed.** A missing `im:history` scope and a refused token already push a hub-level fault and stay there; a Done card stops being followed, as before.
