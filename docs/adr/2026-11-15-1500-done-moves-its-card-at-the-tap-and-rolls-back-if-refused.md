# Done moves its card at the tap and rolls back if refused

Superseded by [a sending card button spins, and the lane waits for the board](2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md): the card stays in its lane, its Done busy, until the board moves it.

A Done tapped in a card's thread goes through this browser's outbox, but its card used to close and change lane only once
the board answered: seconds on a busy host, with the card open and its line reading "sending…".

Now the tap closes the card (app-cards.js confirmTap) and the lanes draw the card in Done while its Done is in the outbox,
queued or in flight (BoardUI.tapped). The outbox announces each write (BoardUI.onOutbox), and the page redraws when the
set of Done taps in it changes. The board's answer lands with the card in Done already; a tap the board refuses (409)
leaves the outbox, and the card is drawn in its lane again, closed, with the board's toast. A failed send stays in the
outbox as not sent, so its card stays in Done until Retry or X.

A Done tapped with the thread field focused (T-273) stays open and in place until the board answers, for the page to
follow it. Implement needs no move: its card stays in Todo, and its Waiting on you row already follows the tap
(2026-11-15-1400-waiting-on-you-follows-the-tap-not-the-board.md). A Done from a card's own button still waits for the
board, which T-420 moves into the outbox.
