# Opening a card the Todo filter hides asks to reset the filter

Status: accepted

A card under an unchecked Todo box is not on the board, so a link, the URL, the
New strip's row or the ? queue that opened it showed nothing, and the New strip's
row was dropped as read.

Now every way into such a card asks "This task is not currently visible, reset
filters?" through the board's one confirm (`B.confirm`). Yes clears the filter and
opens the card. No leaves the filter as it was, drops the card from the address
and keeps the New strip's row, which is marked read only when its card opens.
