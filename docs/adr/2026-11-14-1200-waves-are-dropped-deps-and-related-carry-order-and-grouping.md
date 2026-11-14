# Waves are dropped; deps and Related carry order and grouping

Status: accepted (2026-11-14). Supersedes the wave decisions:
[a wave the owner asks for is a lineup of cards](2026-11-02-1202-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md),
[Plan waves plans from any Todo cards](2026-11-03-0509-plan-waves-plans-from-any-todo-cards.md),
[waves are bands in Todo](2026-11-03-1840-waves-are-bands-in-todo.md),
[every lane groups its cards by wave](2026-11-05-0215-every-lane-groups-its-cards-by-wave.md),
[a grill can propose splitting its card into a wave](2026-11-07-1216-a-grill-can-propose-splitting-its-card-into-a-wave.md),
[a wave's cards wait only on the earlier cards they conflict with](2026-11-09-1321-a-waves-cards-wait-only-on-the-earlier-cards-they-conflict-with.md),
[a card can wait on a whole wave](2026-11-09-2330-a-card-can-wait-on-a-whole-wave.md),
[a card leaves a wave only once no open card waits on it](2026-11-09-2345-a-card-leaves-a-wave-only-once-no-open-card-waits-on-it.md),
and the band half of [group headers lead with a chevron](2026-11-10-0030-group-headers-lead-with-a-chevron.md).

## Context

A wave was a named, ordered set of cards in one item file, shown as a band in Todo with its goal, counts, Notes,
Implement for its next card and Triage; every other lane grouped its cards under wave headers. Since waves'
cards each wait only on the earlier cards they conflict with, the order a wave held was already in its cards'
deps, and the grouping was a second, competing way to say what a split's Parent or a Related link says. Item
files were drawn as bands too, so a card linked from several files read twice (gh #523), and the band, triage,
Plan waves and `wave:<slug>` machinery was a large surface for one view of what deps already carry.

## Decision

Waves go, as a concept and as a band.

- Order comes from deps alone: a card is blocked by the cards it names in `--deps <id>,<file>/<id>`. There is no
  `wave:<slug>` dep, and `item set --done --split-into` takes the split's tasks by key only.
- Grouping comes from Related links and the Parent of a split: the architecture review's findings are Children of
  its audit task and wait on it; a grill's split files Children of the original.
- Item files are storage only. No lane draws a band or group header for a file or a wave, a card shows once
  however many files link it, and a card carries no wave or item-file label.
- With bands goes their triage: no `wave-triage` event, no `wave:<slug>` or `file:<slug>` question topic (question
  add refuses both as undeclared), and no Plan waves row or `plan-waves` event.
- `board.mjs wave …` is gone, and so are `GET /api/notes?wave=` and its notes page.
- A starting hub drops every board's waves once (`migrateDropWaves`, recorded as `drop-waves` in the manifest's
  `migrated` list): each item file loses its `waves` record, and a `wave:<slug>` dep becomes the bare ids of the
  cards that wave held. Deps, Parent and Related to are kept. A `wave-<slug>.md` note stays on disk, unread.

## Consequences

- Todo is a flat list in arrival order; what to build next reads from each card's blocked-by line.
- An architecture review made before this reads 0 built, since its findings were wave cards, not Children.
- Boards over `~/.claude/waves` keep that storage and its `wave.json` name; only the concept is gone.
