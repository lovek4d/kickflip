# On a phone the board and Waiting on you switch in place

Superseded by [one board filter replaces Waiting on you](2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md): there is no Waiting on you to switch to.

#747. The owner, verbatim: "Could we have the open questions page a view switch instead of new page on mobile? Want to go true SPA". Amends [Board and Open questions are two pages](2026-11-07-1300-board-and-open-questions-are-two-pages.md) and [the desktop pane is back without the Needs you deck](2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md), whose phone ? opened Waiting on you as its own page.

Below 900px the shell (`shell.js show`) unmounted the board for Waiting on you and mounted it again on the way back, so the board's scroll, open card and drafts were redrawn from its saved copy and it read as a page change.

- **Both stay mounted.** Below 900px a board and its Waiting on you are kept mounted together. Showing one sets `hidden` on the other's root, which keeps its scroll (the shell saves the window's offset and puts it back), open card, drafts and live updates; the next switch shows it again, with no remount and no fetch. The ?, the check, a question link on the board, a card title on Waiting on you and back and forward all switch this way.
- **The router stays the source of truth.** The URL still changes (board ↔ `questions.html`), with the same history entries as before, so back, a reload, a shared link and a push land on the same view. A switch to a card or question other than the one the hidden view was left on moves it there through a `hashchange`.
- **A hidden view leaves the address alone.** The board and Waiting on you ignore `hashchange` while hidden, and Waiting on you writes no hash and no scroll then, since the address and the window's scroll are the other view's.
- **A short slide.** The view shown comes in over 180 ms, Waiting on you from the right and the board from the left (Web Animations, skipped under reduced motion).
- **Anything else unmounts both.** Another board, the Hub, a framed page (a prototype from Waiting on you included) or Notes unmounts the board and its Waiting on you as before. An unsaved draft on either asks before that; a switch between the two asks nothing, as nothing is lost. Widening past 900px shows the kept board with the topic in its pane.
- **From 900px nothing changes**: Waiting on you is the board's pane.

Other views a phone moves between still unmount and rebuild: a board's prototype page (framed, from Waiting on you), Notes (`notes.html`, which a card's Notes button opens in the reader sheet in place, so only a direct link reaches it), another board and the Hub. Board Settings was already a modal over the board.
