---
status: superseded in part by 2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo and 2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts
---

# A started card never returns to Todo

Superseded in part by [an unstarted card waits on its questions in Todo, and its one action button follows what it waits on](2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md) on grilled: a card counts as grilled once one of its questions is answered or resolved, so one whose questions are all still open hasn't started and waits on them in Todo. The owner's other waits still go to In Review first.

Superseded in part by [a card moves to In Progress only once building starts](2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md) on what counts as started: only building, a build agent's record or a building or fixing status. Being grilled no longer starts a card.

Todo holds only work that hasn't started. A work card counts as started once it has been grilled (it has an `item:` question topic) or built (it has a builder record). `buildBoard` in `board/domain.mjs` keeps such a card in In Progress when it would otherwise land in Todo. That covers its last question being answered, its builder finishing without a new status, or its being blocked.

- **A blocked card keeps its lane.** It shows a "blocked by" chip for each unfinished dep ([cards wait on explicit blocked-by links](2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md)), and an unstarted blocked card stays in Todo. `board.mjs item set <key> --deps <list>` adds deps after a card exists, so a started card can say what it waits on.
- **Held is the only way back to Todo.** A held card ([a card can be held, and every card button confirms](2026-10-29-1639-a-card-can-be-held-and-every-card-button-confirms.md)) is parked on purpose and drops to Todo.
- The owner's waits still go to In Review first ([the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md)). This rule only applies to a card that would otherwise be in Todo.

Once the owner had answered INT-99's last question, the card dropped from In Review to Todo while it waited for INT-104, and read as if no one had touched it.

The owner set this on INT-99: "should not revert from in progress to todo unless intentionally parked, just flag blocked by whatever item".

Considered:
- a `started_at` written when a card first leaves Todo; this rule derives the same thing from records that already exist;
- counting any thread line as started, which would lift cards moved in with a note but never worked.
