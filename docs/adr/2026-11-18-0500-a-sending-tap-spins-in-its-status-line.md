# A sending tap spins in its status line

A tap that logs a thread status line draws that line at the thread's foot at
once, and while it is sending the line reads "sending…" after its time, as an
unsent message's footer does (ui-threads.js PICK_UP). The line's mark gives way
to the sending button's spinner for exactly that state, lane-changing taps
included. Waiting for the host, not sent and sent lines keep their own mark.

The card shows no "sending…" word: only the tapped button spins
(2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md).
