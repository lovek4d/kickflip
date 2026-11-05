# New Todo cards join the bottom, so old ones leave first

The owner on gh232-first-2 (11/05): "flip the order of the to-do items so that new items get appended to the bottom and that way old things actually leave the queue and the backlog doesn't grow in the back." Grill answers on #305: every board flips, with no setting (gh305-scope A); Todo shows the oldest card on top, the order the pull reads it in (gh305-shown A); a prototype round came first (gh305-proto A); a card that arrives glows briefly at the bottom, and Bump moves a card to the top as it does today (gh305-look A).

This supersedes in part [each lane has one fixed order](2026-11-03-0223-each-lane-has-one-fixed-order.md) on how Todo lists the cards after the bumped ones, and [Todo has no queue](2026-11-05-0802-todo-has-no-queue.md) on "the rest newest first" and "else the newest".

- **One flipped lane.** `laneOrder` (`board/public/ui-order.js`) lists Todo as bumped cards first (a New ask lines up with the rest from #331 on), the latest bump on top, then the rest oldest first by `sortAt` (when the card was made), a card with no time last, the first added to its wave file on top. Every other lane stays newest first.
- **The pull and the grill follow.** `pullOf` and `arrivalsOf` walk the board's order, so the pull takes the oldest ready card and the grill takes the oldest ungrilled card, with no change of their own. #232's "the card the pull would build first" is the oldest ready card.
- **Places hold.** A card back from Hold or a refused start keeps its place by `created`. An unbump returns the card to its place by age. Lineup bands keep their phase order; only loose cards and wave-file order flip.
- **The arrival glow.** A work card that appears in Todo on a board the page already drew, and isn't the work card of a drawn New task, flashes once as a card that changed lanes does (`board/public/app-snapshot.js` `signCards`); it sits at the bottom.

Considered:
- a per-board setting (gh305-scope): the owner chose every board, with no setting;
- Todo drawn newest on top with the pull taking from the bottom (gh305-shown): the page would no longer read in the order the pull takes;
- take B (scroll to the new card, a Bumped group) and take C (an arrivals pill, a Next tag): the owner picked A.
