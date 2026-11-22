# A card's menu narrows the board to its chain

The owner (task #953) wanted a button on a card that scopes the board down to the cards related to it, in both
directions, and that daisy-chains: "depth first search with the related to or parent or children and just break the
search on a repeat encounter". Two prototype rounds and a final visual settled it; the owner confirmed the visual with
Implement.

- **A "…" takes the bump arrow's place** at a card's top right. It opens a menu in one layer over the lanes, under the
  "…" or above it when there is no room below: **Bump** (or **Unbump**) when the card can be bumped, then
  **Linked · 1 hop** and **Linked · all** when it has links. A card with neither has no "…" (since
  [tags](2026-11-22-0200-a-card-carries-board-only-tags.md), every card has one, holding Tag…). A card waiting on its
  owner step keeps its Done check, before the "…". The "…" again, a tap elsewhere, Esc or a scroll closes the menu.
- **A bumped card's "…" is filled orange**, as the bump arrow was, so the bump still shows on the card. The "…" follows
  the arrow's hover rule: always on a touch screen, and with a mouse only while the card's header is hovered, unless
  bumped or open.
- **The chain is a depth-first walk with a seen set** over a card's links, both ways: Parent and Children (a follow-up is
  a card with a Parent), Related to, the cards it waits on and the cards it blocks (`ui-cards.js linkedKeys`). 1 hop is
  the card's direct links; all is every card reached. It walks the cards the page holds: the board's, Done's archive
  pages and the search's archive matches. A link to a card the page doesn't hold is in the chain but not walked.
- **While the chain is on, a banner reads "Linked to T-N · 1 hop" or "· all"**, in the hub's hold-banner format
  (owner: "Use the existing banner format like usage limit"), blue as information for the owner to see. Its × or Esc
  (once the search bar is closed) ends it. The chain's own card is marked with a blue edge.
- **Lanes keep only the chain's cards**, each header counting "x of y"; a lane holding none of them hides, and so does
  Auto Review, whose PRs are no card's links. A folded lane holding the chain opens while it lasts and folds back after.
  The New strip is left as it is. Done shows the chain's Done cards the page holds, with no Show more past them.
- **Typed search narrows within the chain**, the banner staying; Esc in the search ends the search first.
- **Choosing Linked on any card re-roots** the chain there: the banner moves, never stacks.
- **A link to a card the chain hides** asks to reset filters, as one the search or the Todo filter hides does; yes ends
  the chain too.
- Like the search's words, the chain lives in memory only: a reload ends it.

Considered: a two-way "Show linked [1 hop | all]" row in the menu (take B), and one "Show linked" item whose depth flips
on a chip (take C); the owner picked two items (take A). For the filter's place, a chip in the search bar (the
recommended take) and a chip-only bar; the owner picked its own banner.
