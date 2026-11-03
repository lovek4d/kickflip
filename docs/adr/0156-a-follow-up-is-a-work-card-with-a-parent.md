# A follow-up is a work card with a Parent

This supersedes [0034](0034-follow-ups-are-todo-cards-of-their-wave.md), whose follow-ups were a list of their own, and [0020](0020-cards-wait-on-explicit-blocked-by-links.md) in part: the open card's Waits on row becomes Blocked by, and a blocker shows Waits on it. Blocked by itself, the `deps` and what they gate, are unchanged.

A follow-up is an ordinary work card. It holds questions, is held, bumped, blocked, grilled, prototyped and built like any card, and counts toward its wave as any card does. What makes it a follow-up is its **Parent**.

**Links.** A card's wave entry stores `parent`, the key of one card, and `related`, a list of keys; a bare id names a card of its own wave, as `deps` do. `board/domain.mjs` gives each card:
- **Parent**: one card or none. A card created from another card's conversation (its thread, a grill or an answer) gets that card as its Parent, through `board.mjs item add --parent <key>`. A card made from the + or New task has none. `item set --parent` sets or clears it, and refuses the card itself or a card below it.
- **Children**: the cards whose Parent it is, the mirror of Parent, sorted by ref.
- **Related to**: similar cards that should be cross-referenced, set by hand with `item set --related <key,…>`. A link shows on both cards whichever one stores it, and `--related` replaces the card's whole list on both sides: a card it leaves out loses its own link back.
- **Waits on it**: the cards it blocks, the mirror of Blocked by.

A card with a Parent carries the quiet follow-up badge; there is no separate tag. A Parent no longer on the board still makes the card a follow-up and reads as its stored id.

**Look** (prototype `link-model`, take A). The open card's details list has a row each for Parent, Children, Related to, Blocked by and Waits on it, each a row of labels that open their cards, after Status; an empty row is left out. Blocked by lists only the deps not yet Done, as the time line's "blocked by" does. The collapsed card shows only the follow-up badge and "blocked by" on its time line.

**Commands.** `followup add`, `followup done` and `followup set` are gone, with the follow-up's Build button and its `build-followup` event: a follow-up builds through the card Build like any card, and Plan waves takes it as any free Todo card ([0153](0153-plan-waves-plans-from-any-todo-cards.md)).

**Migration.** As the board server starts, `store.mjs migrateFollowups` moves each wave file's `followups` into its `items`: each keeps its id, title, ticket and notes, its filed date becomes `created` and its `from` its Parent; an open one is planned and a done one done, closed at its thread's last line. The `followups` key leaving the file records that it ran. A wave whose follow-up has a card's id is left as it is, and the server logs which.

The owner (#87's thread, 11/03): "A follow-up should just be a regular work item that happens to be tagged as a follow-up and has a filed from. But that filed from could even be genericized to a related to." Follow-ups had no status, deps, hold, questions or builder records, so `question add`, `builder start`, Hold and `--deps` refused them, and each that needed work was moved to a card by hand, losing its Filed from (#72, #77, #87, #93). The grill settled the link model: "Parent is automatically filled by when a ticket is created as part of a conversation with another ticket. Otherwise you get parent none if it was created from the new task dialogue. And then children are any tasks that were spun out from a given ticket ... let's drop siblings and have related or relates to instead ... and then waits on it appears as the mirror of blocked by."

Considered:
- a follow-up tag beside a general Related to link carrying both the origin and blocking ties: the origin is one card, a cross-reference is many, and Blocked by gates builds, so they stay three links;
- siblings (cards sharing a Parent) as a link of their own: dropped for Related to, which the owner sets for similar cards whatever their Parent;
- `--related` adding to the list instead of replacing it: replacing matches `--deps`, and a link shown on both sides has to be removable from either.
