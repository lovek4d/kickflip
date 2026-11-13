# The remaining write-then-wait tests nudge until the server acts

Card #640, after #638 (docs/adr/2026-11-13-0045-a-test-waiting-on-the-board-to-hear-a-write-writes-again-until-it-acts.md). Loaded full runs and lands still failed tests of the same shape: a write, then a wait on a board server's reaction to the event its file watch reports. A watch that drops the write leaves the wait to fail.

What changed:

- **`untilHeard`** now carries the waits of headless.test.mjs's second visual agent ("the second launches once the first is done"), its Hold/Resume ("the resume launches its session again"), server-stale.test.mjs's auto review ("the next PR follows the recorded review") and server.test.mjs's prototype-again launch ("the board launches the prototype planner from its brief"). server-builds' tap test and the other planner-brief waits already used it.
- **The /api/board worktree test** waits with `untilHeard` for the served board to name the kept worktree. `boardSees` returns at the first new version, and the board can be built between the wave's write and the agent records' writes, so the card read as missing.
- **The Idle notification test's child script** nudges from its own `until` every 2 s of real waiting and keeps 30 s as the budget it fails at 5× of, as `until` does. Its `[eval1]` error was one of that script's own waits throwing: they gave up at 15 s with no nudge, so a dropped write to the wave or the board's settings ended the run.
- **reply-questions.test.mjs compares `asked_at >= message.ts`.** The command posts the message, then the questions; both stamps are read from the clock, so they can share a millisecond.

Not changed: hub/try.test.mjs's serve-limit test runs its manager in this process, with no file watch to drop a write, so a nudge doesn't fit it. It stays as it was until a failure shows what it waits on.
