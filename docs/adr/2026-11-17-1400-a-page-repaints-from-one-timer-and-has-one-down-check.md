# A page repaints from one timer and has one down-check

T-594 (F8, F9) found the board page running four repaint timers (the status line at 15 s, the recount, the waits sheet and the hub page refresh at 30 s each) and two identical 15 s checks for a down stream (the board's and Waiting on you's).

## Decision

**One page timer.** `B.tick(fn, beats = 1)` (board/public/app.js) registers a job on the page's one 15 s interval, run every `beats`-th beat: the header's "updated" line every beat; the recount, the waits sheet's ages and the hub page refresh (`HubKit.live`, `every / 15000` beats) every second beat. The interval starts with the first job and unmount stops it.

**One down-check.** `B.whileDown(streaming, fn)` is a job that runs `fn` only while the page is visible and the hub stream is down. The board and Waiting on you both use it.

The registry's `board-check`, `questions-check`, `status-repaint`, `recount`, `waits-repaint` and `hub-refresh` entries become `page-tick` and `down-check`. The 5 s down-retry stays its own timer.

## Consequences

An open page runs one interval where it ran several. The 30 s repaints keep their period. The recount and waits sheet no longer drift against each other.
