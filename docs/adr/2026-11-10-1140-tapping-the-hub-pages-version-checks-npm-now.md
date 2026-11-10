# Tapping the hub page's version checks npm now

The version in the hub page's footer is a button. A tap posts `/_hub/check-update`, which runs `upgrade.mjs` `check()` at once, the same check the hub makes at start and every hour, and answers `{state, latest?, error?, commit?}`. The result shows beside the version, in place:

- `checking…` while the request runs (a tap meanwhile asks nothing more),
- `up to date`,
- `pulling <version>…` when a newer one was found (the pull then restarts the hub as it always does),
- `check failed: <why>`,
- on a clone, which never asks npm, `<commit> · pulls with main`.

The owner picked this take (result beside the version) from the t75-version prototype round over a pill with the result inside and a popover with Check again. The popover's "Checked …" line, which would have shown T-70's trace of a quiet check, is dropped with it.

`check()` now returns its state instead of nothing; the timers ignore it. The note stays until the page reloads or the next tap.
