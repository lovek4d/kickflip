# Answered asks fold into the one Done list, the kind shown in the ticket slot

This supersedes in part [answered asks have their own section below Done, and Done and Asks show 10 cards at a time](2026-11-03-0259-answered-asks-have-their-own-section-below-done.md) on the Asks lane, and keeps its "an answered ask stays in Todo until it closes" and its 10-card cap.

- **There is no Asks lane.** An answered ask has lane `done` in `board/domain.mjs`, and `closedLane` is `lane === 'done'`. It is closed like any Done card: no action, no action button, its topic with no open question resolved.
- **One Done list, by close time.** Done's `SORT_AT` is the work card's `closedAt` and, for an ask, its `answerAt`, Claude's latest line or reply on it, so a new reply moves the ask back to Done's top. A moved ask, which has no answer time, falls back to its latest activity.
- **The kind tells a row apart.** An ask keeps the `Ask` badge in the ticket slot and "asked <time>" under its title; a work card keeps its ticket.
- **Done caps at 10 as before.** Asks join its list, its count and its Show more. Asks never archive (`archivedOf` counts only work cards), so the board keeps every answered ask until the ask record retires.

The owner answered on hub/GH-464: an answered ask sits in Done by its latest answer, so a new reply moves it to the top.

Considered:
- ordering an ask in Done by when it was asked: a reply is what brings an ask back to the owner's eye, so the answer moves it.
