# A started card never returns to Todo

Todo holds only work that hasn't started. A work card counts as started once it has been grilled (it has an `item:` question topic) or built (it has a builder record). `buildBoard` in `board/domain.mjs` keeps such a card in In Progress when it would otherwise land in Todo. That covers its last question being answered, its builder finishing without a new status, or its being blocked.

- **A blocked card keeps its lane.** It shows a "blocked by" chip for each unfinished dep ([0020](0020-cards-wait-on-explicit-blocked-by-links.md)), and an unstarted blocked card stays in Todo. `board.mjs item set <key> --deps <list>` adds deps after a card exists, so a started card can say what it waits on.
- **Held is the only way back to Todo.** A held card ([0023](0023-a-card-can-be-held-and-every-card-button-confirms.md)) is parked on purpose and drops to Todo.
- The owner's waits still go to In Review first ([0045](0045-the-lane-follows-who-acts-next.md)). This rule only applies to a card that would otherwise be in Todo.

Once the owner had answered INT-99's last question, the card dropped from In Review to Todo while it waited for INT-104, and read as if no one had touched it.

The owner set this on INT-99: "should not revert from in progress to todo unless intentionally parked, just flag blocked by whatever item".

Considered:
- a `started_at` written when a card first leaves Todo; this rule derives the same thing from records that already exist;
- counting any thread line as started, which would lift cards moved in with a note but never worked.
