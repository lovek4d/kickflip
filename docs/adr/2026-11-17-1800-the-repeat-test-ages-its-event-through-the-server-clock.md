# The repeat test ages its event through the server's clock

The test for [an exact repeat within 30 seconds](2026-11-13-2045-an-exact-repeat-within-30-seconds-is-skipped.md) used to rewrite the `ts` of a recorded event in `events.jsonl` by hand. The board server appends to that file, so an append in between could undo the rewrite and the "later" message was skipped as a repeat (it failed a land once).

The server's repeat check now reads the `now` that `startServer` takes, like its other time reads, instead of `Date.now()`. The test starts the server with a clock it can set 31 seconds back while it posts the first message, so that message is recorded already 31 seconds old, and never touches the log. The clock is set back, not forward: a message posted with the clock ahead would be recorded with a time in the future, which later tests on the same server read.
