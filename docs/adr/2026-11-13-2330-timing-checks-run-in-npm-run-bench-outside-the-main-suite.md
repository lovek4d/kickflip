# Timing checks run in `npm run bench`, outside the main suite

Card #662, from the test audit (docs/test-determinism-audit.md, F10). The owner: no timer-based tests in the main suite; they belong to a perf bench run on its own.

`npm run bench` runs every `board/**/*.bench.mjs` with `node --test`. The main suite never selects them: `node --test` finds only `*.test.mjs`, `board.mjs test` and `affectedTests` take test files only, and the release workflow runs the suite. The package's `files` leave `*.bench.mjs` out, as they do the tests.

`board/server.bench.mjs` holds the folder-churn check, moved whole from `board/server.test.mjs`: the board answers at once while lock folders come and go, sends no change for them, and still sends one for a write in a normal folder. Only a real OS watch tests that, and its latency budget is a measurement. Its site setup stays as [the folder-churn test builds its site aside and bounds its churn](2026-11-12-2135-the-folder-churn-test-builds-its-site-aside-and-bounds-its-churn.md) describes it.

The real-watch rows of the stream test move with F1a, which splits them from the `heard()` units.
