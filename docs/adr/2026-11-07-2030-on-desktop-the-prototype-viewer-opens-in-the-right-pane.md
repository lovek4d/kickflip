---
status: accepted
---

# On desktop the prototype viewer opens in the right pane, with the footer at every width

#429. From 900px a board's prototype page (`/<route>/prototype-*.html`) opens in the board's right pane, in place of Waiting on you. This applies to a link, a push, a hand-off, a history entry, a cold load or a widening past 900px, and it works as a questions URL does ([board and open questions are two pages](2026-11-07-1300-board-and-open-questions-are-two-pages.md)): the shell shows the board at the board's own URL and asks the pane to open the prototype (`shell.js` go, `app-needs.js` openViewer). The pane shows a top bar over the prototype page, framed at the pane's width:

- ‹ Open questions on the left, which returns to Waiting on you with the round's question focused. Choose this does the same through the shell's `focusQuestion`.
- ⤢, which lays the pane over the lanes from the sidebar's edge and back.
- On a card with earlier rounds, the Round pill on the right. Its sheet opens a round in the same pane.

The viewer's footer is now the only bar at every width, so #419's floating pill is retired. From 900px of the page's own width, the footer's pill and note are `min(640px, 100%)` and its state pills wrap. The note field still stays after a pick. In the pane, the page hides its own ✕ and Round pill (`html.ps-pane`, set when `frameElement` sits in `.needs-pane`), starts at the top, and wraps its state pills. A served round's frame (`.kit-served`) and `main`'s bottom padding size from the footer's measured height (`--ps-footer-h`) at every width. The old desktop sizing was a fixed 150px of padding and `100dvh - 210px`, and the bar's wrapped pills and note outgrew it, which cut off the bottom of the prototype.

The owner picked pane width with ⤢ (`gh429-pane-width`), a top bar with ‹ Open questions and the Round pill (`gh429-back-nav`), and the footer inside the pane (`gh429-footer-anchor`) from the prototype `pane-viewer-429`.

While the viewer is open, the window's URL stays the board's, as it does for a question focused in the pane. Narrowing below 900px closes the viewer with the pane. A push to a card's thread (`#item=<key>&reply`) closes it too, so the thread the push points to shows rather than staying under the viewer. That includes the page's own hand-off for a question already picked, and a card opened any other way leaves the viewer open. Below 900px there is no pane, and the viewer stays the full page with the phone footer ([on a phone the bar is a full-width footer](2026-11-10-1000-phone-prototype-bar-is-a-footer.md)). This supersedes the floating pill in [the desktop viewer bar is 640px](2026-11-09-1200-desktop-viewer-bar-is-640px-and-its-state-pills-wrap.md).

Superseded by [the board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md): a prototype opens its own page at every width.

Restored by [the desktop pane is back without the Needs you deck](2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md).
