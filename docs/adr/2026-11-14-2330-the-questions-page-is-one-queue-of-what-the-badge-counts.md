# The ? page is one queue of what the badge counts

#706. The owner: "need to revisit need you badge, seems to overcount by including action needed on things that are not in the open questions. need to find some way to surface those as well, bringing the visible actions up to match the badge". Prototype take C: one queue, oldest first.

Waiting on you lists every Needs you line that waits on the owner there, questions and taps together, and its count is the ? badge's.

- **The queue.** `domain.mjs` `queueOf` builds the board's `queue` from the Needs you lines: a question entry (its topic) for each card or topic with open questions, and a tap entry for each card waiting on Implement (`Tap Implement`), Done or Close, a draft on Ready, or any other Action needed (a stall, a merge, manual steps). It keeps Needs you's order, oldest card first with In Progress ahead (2026-11-05-2130). Prompts and held reviews are left out: the hub page lists the prompts and the Auto Review lane the reviews.
- **The page.** Above the form, `.topics` holds the queue in that order: a topic with open questions stays today's pill, which opens the topic; a tap is a row with its card's ref and title, the waiting word and its age, orange, or red when the card is stalled (AGENTS.md Colour priority). Tapping a row opens its card. The row's button does Implement (`card-build`) and Done (`card-done`) in place, after a confirm; Ready and Action rows have an Open button that opens the card. A count line, "N need you", sits over the queue; with only taps the page is the queue and no form, and with nothing the moon.
- **One count.** `BoardUI.queueRows` gives the rows and their count, read by the page and by the header's ? badge, so they never disagree. The badge counted open questions before; it counts rows now (a topic with several open questions is one). The hub's chip counts the same lines plus prompts and held reviews.
- **The summary.** `needsSummary` names "N actions needed", the cards with Action needed.

Edits 2026-11-06-0037: the page is no longer open questions only. Its moon and "only open topics open by themselves" stand; the form still holds open questions only.
