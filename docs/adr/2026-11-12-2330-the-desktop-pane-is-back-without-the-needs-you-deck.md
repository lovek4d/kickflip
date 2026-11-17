# The desktop pane is back, without the Needs you deck

Superseded in part by [one board filter replaces Waiting on you](2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md): the pane keeps the last sheet, and with none open shows a landing with filter chips in place of Waiting on you.

#607. [The board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md) (#561) took out more than the owner asked for. The owner: "by that i meant the needs you orange backdrop section at the top of the main board view, not the open questions itself".

From 900px, phone landscape included, the board is lanes | pane again, as before #561:

- **The pane** (`#boardPane`, `app-pane.js`) holds Waiting on you embedded, a pill click focusing its card or band on the board. Every questions URL from 900px, a link, a push or a hand-off, shows the board at its own URL with the question's topic open in the pane (`shell.js go`), and the fragment's `openItemsCard` names the pill ([Board and Open questions are two pages](2026-11-07-1300-board-and-open-questions-are-two-pages.md)).
- **The prototype viewer** opens in the pane again, in place of Waiting on you, under its ‹ Open questions, ⤢ and Round pill bar ([on desktop the prototype viewer opens in the right pane](2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md)). It was part of the same pane, and the owner's message asked only for the orange section gone.
- **The seam** between the lanes and the pane drags, and this device keeps its width (`--pane-w`, `hub:paneWidth`, [the desktop columns drag](2026-11-10-1600-the-desktop-columns-drag-and-this-device-keeps-their-widths.md)). The reader sheet lays over the pane at that width, and the board's + sits at the lanes' bottom right ([the + lives on the board pane](2026-11-05-2330-the-plus-lives-on-the-board-pane.md)).

What #561 settled stays:

- **No orange Needs you at any width.** The phone's deck at the top of the board is gone, and so are the pane's orange Needs you lines above Waiting on you (`#waiting`): on a desktop they were that same section at the top of the board's view. A card waiting on the owner shows its Action needed, a held review opens from the Auto Review lane or its push, and a pending prompt is answered on the hub page.
- **The header's ?** with the open-question count as its badge shows at every width. Below 900px it opens Waiting on you as its own page; from 900px it opens the topic in the pane.

Supersedes in part [the board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md): its pane, prototype, layout and fragment parts. Its deck, open-questions badge and pending-prompt parts stand.

Amended by [on a phone the board and Waiting on you switch in place](2026-11-14-2332-on-a-phone-the-board-and-waiting-on-you-switch-in-place.md): below 900px the ? switches to Waiting on you in place, the board kept mounted, rather than opening it as its own page.
