# The hub stream's reconnect and sidebar refresh ride the hub's 15 s clock

`hub/stream.mjs` ran its own 2 s timer to reconnect a dropped board stream and re-scan each board's watcher file, and its own 15 s timer to resend the sidebar, beside the hub's clock.

The stream now returns `reconcile()`, which the hub's `reconcile` job calls each tick, and the existing `refresh()` runs as a new `sidebar-refresh` job on the same clock. The `stream-reconnect` entry folds into `reconcile`. Both do nothing while no page listens. The 25 s ping stays the stream's own timer: it keeps Tailscale Serve from idling an open stream out and isn't a refresh.

Cost: a board stream that drops, such as after a restart, comes back within 15 s rather than 2 s; a page missed no change meanwhile, since a reconnect sends one change. Not measured.
