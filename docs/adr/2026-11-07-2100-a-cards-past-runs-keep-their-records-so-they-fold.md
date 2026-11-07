# A card's past runs keep their records so they fold

A card kept one main agent record, so `builder start` overwrote the last run's. The thread folds a run's lines by finding the record whose `started` matches the line's `run`; with the record gone, the earlier builds', grills' and prototypes' lines stayed open.

- `builder start` over a finished main record keeps that run beside it as `agents/<id>@past-<started ms>.json`: label, kind, model, started, done and log, never calls, worktree or hand-back, which belong to the open record.
- A lander's lines (started, status, finished) carry the run of the newest build before it, so it joins that build's section. The finish step's landing line carries the newest non-lander build's run.
- A section reads finished when its newest line is a finished line, running otherwise, so a finished build that lands reads running again with its earlier finished line kept in place.
- Runs whose record was already overwritten stay plain lines; no fallback name is built.

A past run's record is read by the thread alone: `builderFiles` skips `@past-` files, and domain.mjs `agentsOf` leaves out names starting `past-` unless `threadOf` asks, so the card's agents list, footer and every store reader see only live agents.
