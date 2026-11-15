# Waiting on you follows the tap, not the board

An Implement or Done tapped in a card's thread goes through this browser's outbox. Its Tap row in Waiting on you, and
its count in the ? badge, used to stay until the server's new board arrived: seconds on a busy host, until reconnect
offline.

Now a card whose Implement or Done is in the outbox, queued or in flight, has no tap row and is not counted
(BoardUI.queueRows). The outbox announces each write (BoardUI.onOutbox), so the list and the badge redraw at once. A tap
the board refuses (409) leaves the outbox, and its row returns with the board's toast.

Only taps in the outbox follow. Taps sent straight from a card's buttons still wait for the board, which T-420 and T-429
move into the outbox. A topic with open questions keeps its row: the tap says nothing about them.
