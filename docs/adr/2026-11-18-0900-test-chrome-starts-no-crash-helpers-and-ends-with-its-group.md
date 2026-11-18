# The test Chrome starts no crash helpers, runs in its own process group, and waits 60 s to start

Status: accepted

Each headless test Chrome started chrome_crashpad_handler and, on macOS, GoogleUpdater's `--crash-handler`. Both detach
from Chrome with their cwd in the builder's worktree, so `builder done` counted them as the builder's detached
processes and refused.

`shared/chrome.mjs` now starts Chrome with `--disable-crash-reporter --disable-breakpad --disable-component-update
--disable-background-networking` and without `CHROME_CRASHPAD_PIPE_NAME`, with its cwd in the profile dir, as a
process-group leader. `stop()` kills the whole group, so no helper outlives the test.

The start wait went from 10 s to 60 s: lands failed with "could not start Chrome" on a different Chrome test each run
while the whole suite ran at once, and each test passed alone. The wait is a ceiling, not a delay; a Chrome that starts
quickly returns at once. No cap on concurrent Chromes was added: the longer wait is the smaller change, and a cap can
follow if a land still fails to start one.
