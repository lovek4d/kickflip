# A card carries board-only tags, set from its menu

The owner (task #1154, split 1 of T-730) wanted to attach a tag to a work item from its context menu, "anything, or
selected from existing tags", that follows it for good. The grill settled several tags per card, tags beside Related to
(both kept), and tags that stay on the board; a final visual settled where they show. Filtering by a tag (T-814) and
archiving one (T-815) are their own tasks.

- **A card stores its tags in its item file**, `tags: [<name>, …]`, in the order put on; a card with none has no field.
  A name is free text of 1 to 48 characters, trimmed with its runs of spaces made one, and takes no comma. Two names
  differing only in case are one tag: putting on `Phone` where `phone` is changes nothing (`cards.mjs tagName`,
  `retagged`).
- **`item set --tag a,b` puts tags on and `--untag c` takes them off**, each change a grey Tagged or Untagged line in the
  card's thread naming the tag (`cards.mjs tagItem`). Either goes with the call's other flags; one that changes nothing
  is refused.
- **Every card's "…" opens its menu, Done included**, which now holds Tag… after Bump. Before, a card neither bumpable
  nor linked had no "…" ([a card's menu narrows the board to its chain](2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md)).
- **Tag… opens a picker** under the "…": a field over the board's tags, each with how many cards carry it, most used
  first, ticked where the card carries it. Typing narrows the list; a name no tag has offers New tag. A tap puts a tag
  on or takes it off and the picker stays open for more; Enter picks the tag typed or makes it; Esc or a tap outside
  closes it. The board's tags are those on the cards the page holds, so a tag only on cards archived out of Done isn't
  listed until one of them comes back.
- **The open card lists its tags in a Tags row** above Related to, each whole with a × that takes it off, then
  + Add tag, which opens the same picker under it. The row shows on every work card, for its + Add tag.
- **A pick is a card-tag tap** `{key, tag, on}` through the card's outbox (`domain.mjs tapPlan`): the board server
  writes it to the item file with the owner's line, records no event and wakes no session. The card draws the change at
  once (`ui-snapshot.js tapped`), and a pick that changes nothing is refused with why.
- **Chips sit right of the ticket badge**, two at most, then `+N` whose title names the rest: neutral outlined pills, a
  long name cut with an ellipsis, whole in the chip's title. They don't filter yet.
- **Tags stay on the board**: no ticket source (GitHub, Linear) hears of them.
