# A hub setting orders the pull: oldest first, or last readied first

The owner (11/28): "hub setting: pull in tasks in order of: oldest (topmost in lane) vs most recently staged?" Grill answers on #1245: newest means last readied; the Ready lane follows the setting, so the top card is always the one pulled next; a stale re-check keeps the card's first ready time.

This amends [new Todo cards join the bottom](2026-11-05-2345-new-todo-cards-join-the-bottom.md), which turned down a setting and a newest-on-top Todo, for the Todo cards that are ready.

- **Pull order**, Hub settings' Capacity section, `settings.json` `pullOrder`: `oldest` (the default, today's order: bumped first, then by creation) or `newest`. Each board's snapshot reads it, so the setting reaches every board and its page with the next build.
- **Newest first** gives each ready Todo card `readyAt`, its `ready_first`, else its `ready_at`, else its `created`, and the board `pullAt`, which is `readyAt` under `newest` and null otherwise. `laneOrder` (`board/public/ui-order.js`) puts a card with `pullAt` above the rest of Todo, the last readied on top, after bumped cards. `pullOf` walks the board's order, so the pull takes the top card with no sort of its own; cards blocking one In Progress still go first.
- **A re-check keeps its place.** `restageStaleReady` keeps the first ready time as `ready_first` when it sends a stale card back to staging, a ready set again from staging keeps it, and any other phase drops it. A card readied before the record backfills `ready_first` from `created`, not now, so it doesn't jump the queue.
- **Staged time is not the key**: setting a phase deletes `staged_at` for every phase but staging, so a ready card has none.

Considered:
- Todo kept oldest on top with the pull taking from the bottom: the page would no longer read in the order the pull takes;
- a per-board setting: the owner asked for a hub setting.
