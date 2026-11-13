# The test runner caps concurrency to half the cores

Amends 2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md and 2026-11-05-0100-one-full-suite-at-a-time-on-the-host.md. Suites still run side by side with no slot; each one now starts at most `max(1, floor(os.availableParallelism() / 2))` test files at once.

`nodeTests` (board/worktree.mjs) passes `--test-concurrency=<n>` to `node --test` in the land run, and the builder brief (board/headless.mjs) gives builders the same command, both through `testConcurrency`. Under several builders at once the default concurrency piled files up: a land run at load 40 ran about 6.7 tests in parallel (T-254 Findings 4).

Not measured yet: the before and after wall time and failure count of one land on the real repo, which the card asks to record here. The Mac was loaded by queued lands while this was built, so a timing taken now would be a proxy; record it at the first quiet land.
