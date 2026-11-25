# The run's cutoff timer reads a clock a mocked Date can't move

A test file that mocks Date made exit-with-run's near-cutoff message read a
negative age ("after -1880313 seconds" in a land log), because it measured
elapsed time as `Date.now() - began`.

exit-with-run now takes `performance.now()` when a test file's process loads
and measures elapsed time from it. The cutoff and file-limit timers were
already `setTimeout`s set at load, so they never depended on Date; only the
elapsed time in the message did.

Follows 2026-11-22-1400-a-test-file-still-running-near-the-runs-cutoff-ends-by-name.md.
