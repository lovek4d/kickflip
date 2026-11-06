---
status: accepted
---

# Prototypes have their own button and a full-bleed viewer

Amends [a question's prototypes open in a full-page viewer](2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md): the viewer loses its header and gains a ✕, a Round pill and swipe. Extends [a card's buttons run quiet first](2026-11-06-0035-a-cards-buttons-run-quiet-first.md) with the Prototypes slot it reserved.

A question holds the choice; its prototypes are seen in their own viewer. A card reaches its prototypes from a button of their own, beside its questions.

- **Questions and Prototypes.** The card's Open questions button now reads **Questions**. A card with any question on a prototype page also shows **Prototypes** right after it, whatever its lane, Done included, so old rounds stay one tap away. The row reads Hold, Notes, Serve, Questions (or Mark as done), Prototypes, Merge. Both read the same in every state; only the colour changes: solid orange while unresolved, plain otherwise. Prototypes is unresolved while one of the card's prototype questions is open, which is when its pick is the card's action, so on such a card Questions and Prototypes are both orange.
- **The card's rounds.** `board/domain.mjs` gives each card `prototypes: {open, rounds: [{n, q, url, confirm, state}]}`, its questions on prototype pages oldest round first, or null. Prototypes opens the last round's url. Done cards keep the field (`DONE_FIELDS`).
- **Full bleed.** The prototype page hides its header. A ✕ at the top right clicks the hidden back arrow, so it goes where back goes (the board on desktop, the question on a phone; [on desktop a prototype goes back to the board](2026-11-07-0200-on-desktop-a-prototype-goes-back-to-the-board.md)).
- **The bar.** The floating bar at the bottom has the ‹ take › pager on one row and the pick control on its own row below: **Choose this** (in place of Pick this and Change pick), Picked on the take that is the pick, and Round answered on a resolved question's other takes. Choose this drafts and goes back as Pick did.
- **Rounds.** On a card with more than one prototype question, a "Round N of M · earlier" pill at the top left opens a bottom sheet of the card's rounds, newest first, each open or answered, the one showing marked. A row replaces the page with that round's.
- **Switching.** ←/→ as before, and a sideways swipe of at least 50px, more across than down, not from the left 24px (the drawer's and the browser's edge swipes) and not inside a box that scrolls sideways.

The owner on #287: "anything with a prototype should have a button View prototypes, which opens the prototypes in full screen … strictly separate questions from prototypes". In the grill they chose full bleed with a floating bottom bar, Choose this drafting the pick and going back, the current round with earlier ones one tap away, and the entry as "a button just right of open questions. Orange if new, quiet but still present to visit old choices". Round 1 picked take B (labelled button, pager bar with Choose this on its own row, rounds sheet), with "simplify to plain Questions and Prototypes labels regardless of state; colour alone shows state, orange when unresolved"; round 2 picked solid orange.

Considered:
- an icon-only button with a dot, tabs and Choose this on one row, a Round chip dropping a list (round 1, A);
- a count button ("3 new", "2 rounds") over a Round strip (round 1, C);
- a tinted orange outline, and solid orange with a dot while a round is unseen (round 2, B and C);
- orange while a round is unseen on this device: the owner moved to unresolved, which the board already knows, so nothing is tracked per device.
