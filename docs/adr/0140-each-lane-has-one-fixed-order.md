---
status: superseded in part by ADR-0144
---

# Each lane has one fixed order

Superseded in part by [0144](0144-answered-asks-have-their-own-section-below-done.md): answered asks sit in Asks, below Done, newest answer first.

This supersedes in part [0019](0019-a-card-that-hasnt-started-can-be-bumped.md) on how a lane lists its cards after the bumped ones, and [0012](0012-lists-never-cut-silently.md) on what "newest first" means in Done and its folds. It removes the per-lane sort menu (Recently created or Recently touched, kept per lane on the device) that INT-245 added.

No lane has a sort menu. Each has one order, which `board/domain.mjs` sets: `SORT_AT` gives every card `sortAt`, the time its lane sorts by, and `laneOrder` sorts the board's items by it, newest first, so items arrive in the order the page shows them. A card with no such time falls back to its latest activity (`updatedAt`); one with neither sorts last, the last added to its wave file on top.

- **Todo:** New cards first, oldest first, so the top one is the next taken ([0047](0047-the-plus-makes-a-new-card.md)); then bumped cards, the latest bump on top ([0019](0019-a-card-that-hasnt-started-can-be-bumped.md)); then the rest by when they were made: a work item's `created`, a follow-up's `filed`.
- **In Progress:** by when the card came into the lane (`progressSince`): when it reopened from Done ([0128](0128-a-message-or-question-on-a-done-card-reopens-it.md)), else its latest build agent's start, a build of any kind but `grill` and `prototype` ([0138](0138-a-card-moves-to-in-progress-only-once-building-starts.md)), else its status change when its status is `building`, `fixing` or `checking`. An ask in progress sorts by Claude's progress mark. Bumped cards still lead the lane, as they do in Todo.
- **In Review and Stale:** by when the card came into review, `inReviewSince`, the first time its PR was sent to a reviewer.
- **Done:** by when the card closed (`closedAt`): the latest of the owner's Done, the status change to done, merged or dropped, and the merge. An answered ask keeps its own order in the Answered fold, newest ask first. The Older and finished-wave folds take Done's order.
- **The time line.** A card's last line shows its `sortAt` (`board/public/ui-cards.js`), so it always reads the time its lane sorts by.
- **The idle pull** takes the top pullable card in this order, the one the owner sees on top of Todo ([0123](0123-an-idle-board-pulls-in-its-top-todo-card.md)).

The owner asked on hub/GH-63 to "just drop the sort option": Todo "sorted by creation date which makes sense for a backlog", In Review "sorted by time in lane", and Done "most recently closed at the top, so by date marked done … instead of created". The grill settled Todo with bumped cards first, and In Progress and In Review by time in the lane, the newest arrival on top.

Considered:
- In Progress by its latest activity (Recently touched): the owner chose time in the lane;
- In Progress by its first build agent's start: a card sent back from review gets a new build agent for its fixes, which is when it came back into the lane;
- In Progress by `status_at`: it changes when the card moves to `checking` for the Orchestrator review, which keeps it in the lane;
- putting older cards first in In Review, so they read as more urgent: the owner left it for later.
