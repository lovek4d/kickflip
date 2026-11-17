# A take pick owes a final-visual brief, not the build

T-609's second part: every card that had a prototype round gets a final visual before it builds, and the pick of a take is what leads to it ([a final visual ends on the card's Implement](2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md)).

- **The pick leaves the card discussing.** A Send that picks a take on a card's prototype question and leaves nothing else open moves the card to discussing and owes a visual brief (`store.mjs` `moveOnAnswered`, `domain.mjs` `picksTake`), where it used to go back to the conversation owing nothing, or to staging from new. The final visual's Implement mark shows only from new or discussing, so a pick that left the card prototyping or staging would draw a visual with no Implement.
- **A staged or ready card keeps its place.** The owner's Implement already staged it, and Implement skips the visual, so such a pick goes in the notes as any answer does, with no move and no visual owed.
- **The entry carries the pick.** The owed visual entry's ask is the question, the take's id and the owner's note, so the orchestrator writes the brief (`item brief <key> --kind visual --final`) with the note as guidance; the board then launches the visual agent from it, as for any planner.
- **A note with no take is unchanged.** It prototypes again.
- **Implement is never held.** The card's own Implement still builds before the visual is drawn or confirmed.
