# A grill can propose splitting its card into a wave

Status: accepted; the split's tasks go into no wave since [waves are dropped; deps and Related carry order and grouping](2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md): they are Children of the original, ordered by their deps.

The owner asked (11/07) whether a Discuss on a new task could end with the task broken into a wave of smaller cards, created from that one task, rather than a wave only grouping cards that already exist. Before this, a split happened only after filing: wave triage proposes splits for a lineup's unstarted cards, and the architecture review's audit card files a card per finding. No grill could split its own card.

- **The grill planner proposes it**, on any grill, when the code shows the card has separable parts, each a build of its own (gh431-worth). It is one question for the whole breakdown, options "Split as proposed" and "Keep as one card" (gh431-approve), asked ahead of the prototype question, which stays last. Its context, and the planner's Grill notes, list each proposed card with its title, scope and files, and which build side by side.
- **The orchestrator files the cards** (gh431-filer), not the board: the question carries no split field, and nothing acts on the answer until the card stages. The staging wait's line (domain.mjs `STAGING_NEXT`) says to file the split where the notes answer Split, so a split card is never set ready.
- **The original closes Done**, "Split into #a, #b, #c", as the Parent of every new card (gh431-parent).
- **The new cards always form a lineup** (gh431-lineup): one named after the task, phased by the files they touch, or, when the original is already in an open lineup, they go into that lineup at its place and the original leaves it.
- No prototype round first (gh431-prototype-gate): the change is the grill brief (board/headless.mjs `plannerBrief`), the staging wait line, and SKILL.md.

Calls made at build, left open by the grill:
- The new cards file `--phase grilling`, since `item add` refuses ready without an ask; each one's notes carry its slice and the original's settled answers that bear on it, so its grill doesn't ask them again.
- With a prototype gate yes on the same grill, the prototype round runs on the original, and the split is filed when the card stages after it.

Renaming a lineup to a wave, waves blocking only on conflicts, and a defined splitting method are #436.

From #431, related to #411 (the orchestrator takes new tasks) and #382 (sublanes).

Amended by [a card's gates are facts it keeps](2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md): each card of a split is filed with `item add --split-of <key>`, which copies the original's gates.
