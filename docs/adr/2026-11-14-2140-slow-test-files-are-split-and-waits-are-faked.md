# Slow test files are split by area, and waits in tests run on fakes

Wall time of the full suite is set by its slowest single file, since a file's tests run one after another.

- bin/wait-events.test.mjs drives the watcher in process on an injected sleep, and its session check on an injected
  `sessionGone` (hub/live.mjs takes its ps and live sessions as options). Only the test that needs a real process to
  receive SIGTERM spawns one.
- board/render-check.test.mjs tests a Chrome that fails to start twice on an injected launcher (`startChrome`), not
  on a stand-in script that waits out two real launch timeouts.
- hub/try.test.mjs and board/board-land.test.mjs are split by area (hub/try-main.test.mjs, board/board-builder-done.test.mjs),
  so the runner runs the halves side by side. hub/try-fixture.mjs holds the setup both try files share.
