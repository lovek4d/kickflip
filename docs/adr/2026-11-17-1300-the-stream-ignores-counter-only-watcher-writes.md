# The stream ignores a watcher.json write that only moves its checks counter

`bin/wait-events.mjs` rewrites `data/watcher.json` with a bumped `checks` counter on every empty 2 s pass. `hub/stream.mjs` woke the sidebar on each write, so a listening board recomputed the sidebar every 2 s for nothing.

The stream now keeps, for each watched board, the file's content without `checks`, and wakes the sidebar only when that differs (a watcher starting, exiting, or the file being removed). The watcher keeps writing the counter: its tests use it as proof of a pass, and the stream is the one place that knows what the sidebar shows.

Not measured: no timing of the wakes was taken; the saving is one sidebar computation per 2 s per listening board.
