# The folder-churn test builds its site aside and bounds its churn

Card #637. Since T-258 (434b095b) the folder-churn test in `board/server.test.mjs` timed out at 300 s in every full-suite land, yet passed when its file ran alone. T-258 had it write a marker file the server ignores and wait for a watch of its own to hear it, once after the setup's folders and again once the lock churn had stopped. That assumed the OS delivers file events in order.

Instrumented full runs showed what happens on a busy Mac (five test files side by side, load 4–7):

- **The OS dropped the churn's events, marker included.** Alone, a 3 s churn queued about 23,600 file events, which arrived at about 500 a second, so the marker came through after 50 s. In the full suite, delivery came in bursts with 10 s gaps. It stopped for good after 4,612 of the churn's events, and the marker written after them never arrived. The wait's budget was 60 s, so it only failed at 5× that, 300 s, which was also the runner's limit. The runner timed the test out first. Its `finally` never ran, so the lock-churn child and the `board-churn-*` folder were left behind.
- **A marker can take several writes to be heard.** With the marker rewritten every 2 s, one run needed 7 writes over 14 s.
- **Events don't arrive in order.** Setup folders' events reached both the test's watch and the server after markers written later, so hearing a marker doesn't mean what came before it is in. The server also heard its own first `action-pushes.json` and `orchestrator-waits.json` writes 7 s after they landed. Late events like these sent a change during the churn, which failed "lock folders coming and going send no change" with nothing wrong in the board.

What changed:

- **The site is built aside and renamed into place before the server starts.** An event keeps the path it had when it happened, so the setup's thousands of folders, however late their events arrive, are never under the server's watch. The data folder already holds `action-pushes.json` and `orchestrator-waits.json` as an empty board leaves them, so the server's first checks write nothing. Before the churn, the server hears no event at all.
- **The churn is bounded.** Each churn makes and removes 500 lock folders, then exits. Its events stay well under the point where the busy run started dropping. The board's load during the old 3 s window was set by the delivery rate anyway, not by the size of the churn.
- **The lock events are in once the test's watch has heard the marker and then 2 s of nothing.** The marker is written after the churn ends, and again every 2 s until it is heard. Since order isn't guaranteed, the marker alone isn't enough. A late lock event after that can only make the no-change check pass when it shouldn't. It can't make it fail.
- **The board answers at once until the locks' events are in.** The health checks run from the churn's start until then, and for at least 3 s, which covers the whole time the board takes in the lock events. The 250 ms budget still only warns, and a single answer fails at 5× it.
- **Every wait has a budget whose 5× fits inside the runner's 300 s.** A wait that never comes fails with what the test's watch heard, instead of hitting the runner's timeout.
- **Cleanup is an after hook.** The test runner runs `t.after` even when it times a test out, and it skips the test's own `finally`. The server, the stream, the watch and the churn stop there, and the temp folder is removed. A churn child also exits once the test process is gone (`untilTestEnds`).

Lock events the OS drops never reach the board either, so for those the no-change check holds trivially. A run where every lock event was dropped would still pass, but the final write's change shows the board was hearing that folder tree all along.
