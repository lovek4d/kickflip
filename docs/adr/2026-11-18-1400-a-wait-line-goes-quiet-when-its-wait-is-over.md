# A wait line goes quiet when its wait is over

A land that finds another card landing or testing writes a "Waiting for … to land" or "Waiting to test: …" line, orange
while the wait is on. The thread draws a line in the tone it was written with, so the line stayed orange after the wait.

- The land records the end of each wait in the thread as a `wait-over` line, `{of: the wait line's ts}`, written where
  the land stops waiting (worktree.mjs `onTurn` and `onTestTurn`, called once a wait that happened ends, got its turn or
  threw) and when the land itself ends (finish.mjs `waitLines`). It draws nothing. Nothing already written is rewritten.
- A wait line carries the pid of the process that waits. One with no recorded end whose pid is gone reads as over, so a
  land killed mid-wait can't leave an orange line. A wait line from before this change has no pid and reads as over.
- The thread draws a wait line grey once its wait is over (hub-lines.mjs `waitsOf`, domain.mjs `threadOf`), whatever was
  written after it while it was on; the card's merging Next (`mergingNext`) names a wait only while it is on.
- Rejected: greying a wait line once any later status line follows it. A wait stays on while other lines are written.
