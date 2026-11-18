# An unread request re-wakes the orchestrator in 2 minutes, and Stop names it

[Requests arrive as a signal](2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md), so a request the session never read sits waiting… with only the one signal line to prompt it. The 15 minutes a wait nobody picked up goes between wakes ([nothing waiting on the orchestrator is missed](2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md)) is too long for the owner's own words (T-561, t561-rewake).

**Unread is an unpicked request wait.** The waits that hold an owner's request are `REQUEST_KINDS` in `board/domain.mjs`: a reply on a task and a New task's intake. One with no pickup is one no `inbox read` has handed over, since the read is what stamps it.

**A 2-minute re-wake, on its own clock.** `waitsStep` wakes an unread request `REQUEST_REWAKE_AFTER` (2 minutes) after its last wake, not 15. It ignores the board-wide reminder clock and leaves it alone: it neither waits for that clock to open nor resets it, so a request nobody reads every 2 minutes doesn't starve the 15-minute waits of their reminder. Read, it keeps the hourly re-wake of a picked wait.

**Stop names them.** `/api/working` also lists `unread`, each request wait with no pickup, and `hooks-plugin/hooks/watcher-stop.mjs` blocks the turn's end naming each with `board.mjs inbox read`, beside the watcher and Working-on-it checks. It blocks at most once a turn as before.

**Not done here.** An answer, a question, an overnight triage and the board's other waits keep their 15 minutes: only the kinds inbox read hands over are unread in this sense.
