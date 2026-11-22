# An archived tag greys out and leaves the picker

The owner (task #1158, split 3 of T-730) settled that archiving archives the tag itself, not the cards carrying it
([a card carries board-only tags](2026-11-22-0200-a-card-carries-board-only-tags.md)).

- **The board keeps its archived tags in `data/tags.json`**, `{archived: [name, …]}` (`cards.mjs archiveTag`,
  `readArchivedTags`). Names match whatever their case; one board-level list, so a tag no card carries can be archived
  too. A card's item file is untouched: an archived tag stays on its cards for good, Done included.
- **The picker's rows each have an Archive**, and an archived tag is no pick: it sits greyed in an Archived group
  below the picks, with a Restore. A typed name an archived tag has is that tag, so no New tag is offered for it.
- **An Archive or Restore is a `tag-archive` tap** `{key, tag, on}` (`domain.mjs tapPlan`) through the open card's
  outbox: the board server writes `data/tags.json`, records no event and wakes no session; one that changes nothing is
  refused with why. The built board carries `archivedTags`, and each card the `archivedTags` among its own tags
  (`domain.mjs buildBoard`), which its chips draw grey.
- **Not done**: no CLI flag for agents, and archiving leaves no thread line, since it is no card's change.
