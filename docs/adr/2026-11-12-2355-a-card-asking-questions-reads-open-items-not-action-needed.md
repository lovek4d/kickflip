# A card asking questions reads Open items, not Action needed

The card's badge (`actionWords` in board/public/ui-cards.js) picks its word from the action's kind. A card waiting on the owner's answers (pick, questions: domain.mjs's `ASKING`) reads **Open items**; every other kind (implement, close, merge, ready, steps, stalled) keeps **Action needed**.

- Only the card's badge changes. Pushes keep saying Question and the sidebar's "needs you" count is unchanged.
- Open items stays orange and keeps the link and aria-label, which follow the word (colour priority in AGENTS.md).
