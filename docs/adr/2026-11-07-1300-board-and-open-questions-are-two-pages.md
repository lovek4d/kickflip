# Board and Open questions are two pages

Card #323. The owner, verbatim: "open questions page should not be accessible on desktop at all in fact, consider refactoring/restructuring to make that more clear. they are two pages, and on desktop side by side, on mobile nav between the two". Amends [Needs you is a deck on a phone and a pane on a desktop](2026-11-05-0408-needs-you-is-a-deck-on-a-phone-and-a-pane-on-a-desktop.md) and [on desktop, a prototype goes back to the board](2026-11-07-0200-on-desktop-a-prototype-goes-back-to-the-board.md), and folds in #322 ([the + is the board page's alone](2026-11-07-0100-the-plus-is-the-board-pages-alone.md) had already done it).

- **One rule in the shell.** From 900px, `shell.js` `go` turns every view of `questions.html` into the board at the board's own URL, with no topic in the address bar, and asks the board's pane to open the topic (`app-needs.js` `focusQuestion`). That covers a link anywhere on the board, a push tap, a framed page's hand-off, a history entry and a cold load. On the board already showing, it changes no URL and adds no history entry, so an open card stays open. #312's click catcher on the board is gone; the router's own click handling reaches the same rule.
- **The pane opens any topic.** The embedded Waiting on you exposes `B.openTopic(id)`: a topic id or a question id opens that topic, a resolved one included, and no id or one that's gone opens the topic the page would open by itself. It answers false until its first load, and the shell asks again until it answers. #316's double-click from a pill to its card stays as the pane's link back to the board.
- **Widening swaps.** Widening past 900px while Waiting on you shows replaces it with the board, its topic open in the pane. Narrowing on the board stays on the board, whose pane gives way to the deck.
- **Below 900px, a ? and a check.** The board header carries a bare ? drawn like the other line icons, with the open-question count as a badge on its corner (hidden at none); it opens Waiting on you. Waiting on you's header carries a bare check in the same place, a back link (`a.back`), so the router climbs the page tree to the board. It has the logo in place of the back arrow, since the check is its way back. From 900px neither shows.
- **The bulb and gear sit at the foot of the board**, under the lanes, at every width (`BoardUI.boardFoot`). The header keeps the time and refresh. The header no longer draws a gear for any page.

Considered:
- **A Board · Questions switch in the header** (prototype round 1, take B). The owner preferred a single button, as space in the phone's header is short.
- **A circled question mark, or the count beside the ? or in a pill, or a dot** (round 2). The owner asked for a bare ? and leaned to the corner badge.
- **The bulb and gear as buttons at the top of the board, or in the header beside the ?** (round 3). The owner picked the bottom of the board.

Superseded in part by [the board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md): the two pages are apart at every width, with no pane from 900px, and the header's ? shows on a desktop too.

Restored by [the desktop pane is back without the Needs you deck](2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md): from 900px the two pages sit side by side again, Waiting on you in the pane; the header's ? stays at every width.

Amended by [on a phone the board and Waiting on you switch in place](2026-11-14-2332-on-a-phone-the-board-and-waiting-on-you-switch-in-place.md): below 900px the ? and the check switch between the two, both kept mounted, in place of opening a page.
