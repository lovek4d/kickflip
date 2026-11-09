---
status: accepted
---

# A lineup is called a wave, and the wave file an item file

Renames the code side of [a wave the owner asks for is a lineup of cards](2026-11-02-1202-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md), whose model stands: the owner's named set of cards in steps is now called a wave in code, data, commands and docs, as the owner already calls it, and the JSON file a board's cards live in is an **item file**.

- **Commands.** `board.mjs wave create|add|remove|set|finish` replace `lineup …`; there is no `lineup` alias. A card key is `<file>/<id>`, `<file>` being its item file's slug.
- **Data.** An item file lists its waves under `waves` (was `lineups`), and a wave's note is `wave-<slug>.md` beside it (was `lineup-<slug>.md`). A board over its own cards keeps them in `data/items.json` (was `data/wave.json`); a board over `~/.claude/waves` still reads wave-build's `<slug>/wave.json`, and `items: "waves"` keeps its name.
- **Topics and events.** A wave's triage topic is `wave:<slug>` (was `lineup:<slug>`), and an item file's is `file:<slug>` (was `wave:<slug>`). `wave-triage` carries `{wave}` or `{file}`, `wave-move {wave, key, by}` replaces `lineup-move`, and `arch-review` and `data/arch-reviews.json` carry `wave` or `file` with no `lineup` flag. A github-change's PRs, a done-archive entry and `/api/board`'s cards name their item file as `file`, and a card in a wave carries `wave: {slug, title}`.
- **Pages.** Band kinds are `wave` and `file`, Done's finished-item-file folds are `file:<slug>`, and the open card's Wave row names the card's wave, gone for a card in no wave.
- **Steps stay `phases`.** Renaming a wave's steps is #451's.

## The migration

The hub runs `board/store.mjs` `migrateWaveNames` once as it starts, before it starts any board, under the manifest lock, and records `wave-names` in the manifest's `migrated` list; after that only the new names are read. For each board it:

- renames a `wave.json` named by board.json `items` to `items.json` beside it, and writes board.json's `slug` as `wave` when it had none, so every card key, thread file and topic keeps the slug it had;
- moves each item file's `lineups` into `waves` and renames `lineup-<slug>.md` to `wave-<slug>.md`;
- rewrites topics in every `data/*.json`, `wave:<slug>` to `file:<slug>` before `lineup:<slug>` to `wave:<slug>`, matching only a whole topic string, never a sentence that mentions one;
- renames a done-archive entry's `wave` to `file`, and an arch-review record's `{wave, lineup: true}` to `{wave}` and `{wave}` to `{file}`.

`events.jsonl` and the threads are history and stay as written; no code replays an old `lineup-move` or `wave-triage {lineup}`. wave-build's `~/.claude/waves` files have no lineups and are left alone.

Considered: reading both names for a while instead of migrating. Every reader would carry both shapes, and the owner asked that only the new names be read after the hub starts.

Owner on #436's gh436-rename-scope: "Everything: the data field, note files, topics, events and code identifiers too, with a migration of the lineups that already exist, and the storage "wave file" gets a new name so the two don't clash." On #450's grill the owner named it Item file, and chose the migration once at hub start over every board, then only new names; the orchestrator settled that `data/wave.json` is renamed on disk.
