---
status: superseded by 2026-11-05-0802-todo-has-no-queue
---

# Queued sits at the top of Todo, not the bottom of In Progress

Superseded by [Todo has no queue](2026-11-05-0802-todo-has-no-queue.md): Todo has no Queued section.

The owner asked on #212 (11/04): "Queued should live at the top of to-do, not at the bottom of in-progress." A queued card hasn't started, so Todo is where it belongs; In Progress now holds only cards a build has started.

This supersedes [In Progress has a Queued section](2026-11-04-0121-in-progress-has-a-queued-section.md) on where the section lives and what it counts. Everything else there stands: its members, its order, the pull taking its top, the pullable rule.

- **Todo leads with Queued.** Todo lists one section headed "Queued" with its count first, then its wave bands and cards in no wave (`board/public/app-lanes.js` `todoRows`). A queued card is `lane: 'todo', queued: true` (`board/domain.mjs` `buildBoard`) and is left out of the wave bands. Todo's count includes it; In Progress's does not.
- **Order unchanged.** Bumped cards first, the latest bump on top, then the rest oldest first by when they were asked for; `laneOrder` now puts queued cards ahead of the rest of Todo, so the top one is the next to build.
- **No Implement button.** A queued card's Implement is already pending, so it shows none (`ui-cards.js` `buildButton`).
- **Triage** still reads the queued cards that are buildable, now as Todo cards.
- **The pull** is unchanged: queued cards hold no implementer slot.

Considered:
- keeping queued cards in their wave band and marking them: the section's point is one list in start order across waves;
- a wave band naming a queued card "queued": the cards are in Todo now, so the band no longer lists them apart from the section.
