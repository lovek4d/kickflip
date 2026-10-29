# A card that hasn't started, or is running, can be bumped

Work cards in Todo and In Progress, and open follow-ups, which sit in Todo ([0034](0034-follow-ups-are-todo-cards-of-their-wave.md)), have a "Prioritize" button in their action row, between Hold and Grill ([0023](0023-a-card-can-be-held-and-every-card-button-confirms.md)), as a waiting ask has its bump icon ([0014](0014-a-pending-ask-can-be-deleted-or-bumped.md)). A held card has none, and neither has a draft waiting on the owner's Ready, since the owner is the next step there.

- **Prioritize** sends a `card-bump` event `{key}`, the card's `<wave>/<id>`. Asks keep `ask-bump {id}`: the two name different things and ask the session for different work.
- **A card that hasn't started** (`planned`, `waiting`, or no status) starts next once it is unblocked ([0020](0020-cards-wait-on-explicit-blocked-by-links.md)).
- **A running card** (`building`, `fixing`) is prioritized: the session handles its next step ahead of other work, such as its builder's questions, review fixes and CI. Among cards waiting for a free builder, it goes first.

Every lane lists bumped cards first, the latest bump on top, then the rest by their latest activity, newest first. A card with no activity yet sorts after those, the last added to its wave file on top. The button is disabled on the lane's latest bump. Bumps are events, so the order survives reloads and the session learns of them through its watcher, as with Ask bumps. A bump stops counting once the card leaves Todo and In Progress.

The owner had no way to change which planned card started next, or to hurry a running one, without writing an ask.

Considered:
- dragging cards to reorder a lane;
- keeping to an ask that names the card.

The owner chose the bump button (round `site-v12`, question `v12-card-bump`), and asked for it on running cards too, with every lane newest first (in S10's thread), and for it as a named button in the action row (INT-19), reading "Prioritize this" (INT-25), then "Prioritize" (INT-41).
