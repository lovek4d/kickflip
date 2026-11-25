# The owner links and unlinks a card's Related to by hand

Related to links were set only by the orchestrator (`item add`/`item set --relate`, and notes that name a card), so
the owner could see a card's links but neither add one nor take one off. The owner asked to link tasks by hand, and to
remove links as part of it. A grill and a prototype settled where the control sits, how the other card is picked and
how a link comes off; the owner picked the search inline in the row over a popover under the add chip.

- **The open card's Related to row is always shown**, after Tags, for its add chip. Each link is a chip like a tag's:
  the card's ref with its lane ring, which opens that card, and a × that unlinks it in one tap. The row ends in
  + Add link. Before, the row was comma-separated text links, left out when empty.
- **+ Add link turns into a search field in the row itself** (`ui-cards.js relatedRow`), with the hits under the row:
  this board's work cards whose key, ticket or title holds the words typed (the board search's `cardMatches`), open
  ones first and then Done, at most eight, leaving out the card itself and the cards it already links. A tap on a hit,
  or Enter for the first, links the card and closes the field; Esc, the field's × or a tap anywhere else closes it. The
  row grows by the hits while the field is open and settles back on close.
- **Links stay on the board.** Only this board's cards are offered; there is no cross-board link.
- **Any link can be removed, whoever made it.** No record says who made a link, and none is added.
- **A removed link can come back**: `item notes` relates every card a new section names, so notes that name the card
  again link it again. The owner chose to keep it simple over a sticky removal.
- **A pick or × is a card-relate tap** `{key, other, on}` through the card's outbox (`domain.mjs tapPlan`): the board
  server writes the link, or takes it off whichever card stores it, with the owner's Related to or Unrelated from line
  in both threads (`cards.mjs relateItem`), records no event and wakes no session. Both cards draw the change at once
  (`ui-snapshot.js tapped`). One that changes nothing, links a card to itself or names no card on the board is refused
  with why. Unlike `item set --relate`, it doesn't wait for the orchestrator's reply on a card whose owner waits on one:
  the owner made the link.
- **Every chip in the Tags and Related to rows is 28px**, a tag or link chip with its ×, the add chip and the search
  field alike, so a row is 32px with chips or without (owner: "the chip should not change the height of the row, and
  should be the same as the add chip"). Before, a tag chip was 28px and + Add tag about 22px.
- **The search field takes its own Escape** (`data-own-escape`): the sheet stack's Escape, which closes the top
  sheet, passes it by, so Esc closes the field and leaves the card open.
