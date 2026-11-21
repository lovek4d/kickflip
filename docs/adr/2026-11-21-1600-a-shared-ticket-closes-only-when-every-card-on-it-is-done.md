# A shared ticket closes only when every card on it is done

A card's close moved its ticket to Done even while another open card on the board shared that ticket, and a card
closed because its PR was closed unmerged (`prs-closed`) moved it too. The hub's PR poll (`followPRs`) already waited
for every card to merge.

The board's close path (`board/cards.mjs` changeItem) now leaves the ticket open when another open card on the board
carries it, and when the close is `prs-closed`. The last card of a shared ticket to be done closes it. Only the board's
close path changed; the hub's poll and the ticket layer's policy are as they were. Cards on other boards, and a
card's legacy Linear links, are not weighed here: the poll weighs them.
