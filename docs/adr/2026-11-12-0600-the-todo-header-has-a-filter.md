# The Todo header has a filter

The owner (card #559) wanted to set aside held or blocked cards without leaving the Todo lane.

- **A funnel at the right of the Todo header** opens a checklist of five boxes: Ready (phase ready or staging), Discussing (discussing or new), Planning (grilling or prototyping), Blocked, Held. All are checked by default.
- **No precedence.** Each box tests one property of the card. Unchecking a box hides every Todo card with that property and nothing else, so a card that is held and blocked hides when either box is unchecked.
- **The funnel goes orange** (the notice colour) while any box is unchecked, and the lane count reads "N of M".
- **Kept per device** in the board's store (`todoFilter`, the unchecked boxes); the checklist's open state is not kept.
- **Todo only.** The other lanes have no filter yet.

Considered: ordering the boxes by the colour priority. The owner said the filter has no precedence, so the order is only the order of reading.
