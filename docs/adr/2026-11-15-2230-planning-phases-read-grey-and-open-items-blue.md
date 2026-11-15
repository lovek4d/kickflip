# Planning phases read grey, and Open items reads blue

A card's footer word for discussing, grilling and prototyping is grey (`PHASE_LOOK` in board/public/ui-cards.js), whoever's turn it is; the discussing word no longer turns blue on the owner's turn. A New card draws a blue "new" word, where it drew none. Staged (orange) and ready (green) keep their colours.

Open items, the badge on a card asking questions or picking a prototype, is blue (`.card-open-items`): open questions are something for the owner to read or see, the colour rule's blue. Action needed stays orange. This replaces the orange Open items of [a card asking questions reads Open items, not Action needed](2026-11-12-2355-a-card-asking-questions-reads-open-items-not-action-needed.md).

Owner ask, #796: "Change discussing grilling etc footer text to gray, and use blue for Open Items", then "new might be good as blue".
