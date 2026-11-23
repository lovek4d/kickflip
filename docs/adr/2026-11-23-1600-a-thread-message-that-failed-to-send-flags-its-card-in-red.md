# A thread message that failed to send flags its card in red

A message, tap or answer set the board refuses, or doesn't answer in 15 s, stays in the browser's outbox as "not sent"
inside the open thread. A send that failed while the owner looked elsewhere went unseen.

The card now carries a red "not sent" in its alert row, beside "stalled" (red: it needs the owner now, per the colour
priority). The open task's header is the card's own face, so it carries the same flag; a tap on it scrolls to the failed
message's Retry, and on a closed card opens the card.

- It is drawn from the outbox (`BoardUI.tapped` sets `notSent`), so it shows only on the device that wrote the message.
- It does not count in the header's "N need you" (owner, 11/23): the count is the board's, the outbox is one browser's,
  and counts would differ between devices.
