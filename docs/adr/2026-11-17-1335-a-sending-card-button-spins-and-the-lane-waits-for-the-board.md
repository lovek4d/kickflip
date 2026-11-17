# A sending card button spins, and the lane waits for the board

Card #1006 (T-555). On T-552 a Done tap drew its card in Done at once, while the card's orange Action needed, drawn from
the board, still read as if nothing had been tapped. The owner (11/17): "The buttons should also disable (always on any
spinner or status like sending… type wait). Actually how about we always do that (disable + spinner while sending)", and
"Lane change should happen after confirmation for now, to avoid janky rollbacks".

Supersedes [Done moves its card at the tap and rolls back if refused](2026-11-15-1500-done-moves-its-card-at-the-tap-and-rolls-back-if-refused.md),
and, for card buttons, "its button free" in
[every reply box tap shows its line at once](2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md)
and "No button is held" in [owner taps wait for the host in the outbox](2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md).
The rest of each stands.

## Decision

One seam draws a card from this browser's outbox: `ui-snapshot.js` `tapped`. A card with a tap in the outbox, queued,
in flight or waiting for the host, and not failed, carries `sending`, the list of its tapped buttons' acts: `finish` (Done,
the owner check), `build` (Implement), `merge`, `hold` (Block), `resume` (Unblock), `reopen`, `cancel`, `bump` (Bump and
Unbump), and the requests `prototype`, `grill`, `visual` and `review`.

- **The button waits.** Each card button draws `ui.js` `BUSY` while its act is sending: disabled, its label hidden behind
  the spinner at the same width. That covers the thread box's second button (`app-threads.js` `sends`), the ticket
  actions' Block, Unblock and Done (`app-cards.js` `actions`), the owner check (`ui-cards.js` `ownerDoneButton`), Merge
  and the menu's Bump (`ui.js` `cardBumpItem`), and the thread box's request buttons (`app-threads.js` `syncSends`). A
  second tap can't send twice.
- **Its Action needed clears.** A tap that is the card's `resolvedBy` button (Done, Implement, Merge) drops the card's
  `action` and `resolvedBy` while it sends, as #1001 does for sent answers (`tapped`, then `answered`).
- **The lane waits.** Lane, phase and order stay as the board has them. Done no longer closes or moves its card at the
  tap; an open card stays open, and closes in its new lane when the board's answer moves it (`app.js` `render`). A bump
  no longer re-sorts or flips its "…" at the tap. Implement no longer turns into Cancel at the tap.
- **A refusal brings the button back.** A 409 drops the tap from the outbox with the board's toast, and a failed send
  (not sent, Retry and X) stops counting as sending, so the button and the Action needed are back as the board has them.

`confirmTap`'s `follow` (a Done tapped with the thread field focused stayed in place) is gone: every Done stays in place now.

## Not here

- The thread status line's spinner and where "sending…" text shows: T-661.
- The thread box's Reply stays free: it sends the typed text, and messages queue one behind another.
- Taps that send direct (Serve, Build, Kill, Run a review) already wait on their own (`B.spinUntil`).

## Considered

- Moving every tap's card at once and rolling back on a refusal: the owner chose lanes after the board's confirm, to avoid
  janky rollbacks.
- Clearing Action needed on every tap: a Block or a bump doesn't resolve the card's Action needed, so it would come back
  with the board's answer.
