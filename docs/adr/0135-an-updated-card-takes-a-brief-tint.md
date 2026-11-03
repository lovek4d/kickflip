# An updated card takes a brief tint

A card on the board shows that it changed since the page last drew it, a last visit's board included, with one of two signs, never both (`board/public/app-snapshot.js` `signCards`):

- **The flash**, a blue border round the card that fades in 1.6 s, for a card that changed lanes or a work card that took a New task's place.
- **The tint**, an accent-soft background on the card's title row that holds briefly and fades out over 2.4 s, for any other update. An update is a new thread line, a status or Next line change, or a PR or CI change: what `board/public/ui-snapshot.js` `updateSign` reads.

A change the owner sent from this page, a reply, Mark as done, hold, resume, merge, build, bump, nudge, grill or prototype request, shows neither sign: the card's next change is held unsigned until the first board load started after the send settles. A repaint while a sign runs puts it back as far in as it was, so another card's update doesn't cut it short or restart it.

When the fresh board replaces the last visit, lane counts, Needs you lines and thread messages that read differently still flash themselves ([0028](0028-the-board-opens-on-the-last-visit.md)); card lines no longer flash the whole card, since the card's own sign says it changed.

The owner asked for some sign that a card was updated, other than the lane-move border (hub/GH-39). Three takes were drawn through the real card lines in prototype `card-updated`, and the owner picked the tint (take C).

Considered:
- an accent dot before the title that stays until the card is opened (take A, the recommendation), which shows even if the owner wasn't looking;
- the time line reading "updated just now" in the accent colour for about 6 s (take B);
- the border flash for every update, which would no longer tell a lane move from any other change.
