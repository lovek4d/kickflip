# A board keeps its open sheets while another shows

Switching to another board unmounts the one left; it already keeps its scroll, focused box, filter, open cards and
drafts in memory for its next mount in the page (`B.keep`, `B.place`). Its open sheets were lost, because the sheet
stack (ui.js `layers`) holds live `<dialog>` elements and touches neither the URL nor history.

Each sheet's part registers with `B.keepSheet(name, sheet, save, reopen)` (app-core.js). As the board unmounts, every
open sheet saves what it shows, in stack order; `restorePlace` reopens them in that order after the first render and
before the scroll goes back, and skips them when the URL names a card.

- Questions sheet: its topic and whether it followed the opened card. A topic with no open question left is not
  reopened.
- Reader sheet: its views bottom first, each a card page's URL, a transcript's file or a card's notes. Notes of a card
  gone from the board are skipped.

Keeping every visited board mounted and hidden was rejected: each board registers `hashchange` and `pointerdown`
listeners on the page, and the question drafts are one singleton pointed at one site, so hidden boards would read
the visible board's hash and drafts.

Board Settings stays as it is: the shell owns it and drops it on every switch.
