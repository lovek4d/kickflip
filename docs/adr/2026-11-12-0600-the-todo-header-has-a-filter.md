# The Todo header has a filter

Superseded by [one board filter replaces Waiting on you](2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md): one filter in the header covers every lane, kept as `boardFilter`, with Action needed and Questions boxes in place of Planning and Held, and no count.

Superseded in part by [the owner's hold is a block](2026-11-15-2230-the-owners-hold-is-a-block.md): the Held box goes, and Blocked covers the owner's block.

The owner (card #559) wanted to set aside held or blocked cards without leaving the Todo lane.

- **A funnel at the right of the Todo header** opens a checklist of five boxes: Ready (phase ready or staging), Discussing (discussing or new), Planning (grilling or prototyping), Blocked, Held. All are checked by default.
- **No precedence.** Each box tests one property of the card. Unchecking a box hides every Todo card with that property and nothing else, so a card that is held and blocked hides when either box is unchecked.
- **The funnel goes orange** (the notice colour) while any box is unchecked, and the lane count reads "N of M".
- **Kept per device** in the board's store (`todoFilter`, the unchecked boxes); the checklist's open state is not kept.
- **Todo only.** The other lanes have no filter yet.

Considered: ordering the boxes by the colour priority. The owner said the filter has no precedence, so the order is only the order of reading.
