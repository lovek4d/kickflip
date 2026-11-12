# A card link shows the card's current ref

A card is linkable by its ref and by its own id, so an old "T-144" in an
older message still opens the card. The link now prints the card's
current ref (#548, PAD-123), not the word as written. When the two
differ, the written word is the link's hover title ("was T-144").

The ref map sits beside `lanes` in `linkContext` (board/public/ui-links.js),
so threads, notes, questions and the New strip all follow.
