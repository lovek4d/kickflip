# A building card's phase bars end its time row

This supersedes [a building card shows its phase as five bars under its status line](2026-11-03-0458-a-building-card-shows-its-phase-as-five-bars.md) on where the bars sit and which cards show them. The bars themselves, the phases and the status line stay as [a building card shows its phase as five bars under its status line](2026-11-03-0458-a-building-card-shows-its-phase-as-five-bars.md) and [a builder status line is a phase and a short detail](2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md) have them.

The five phase bars sit inline in a building card's time row, after a " · " and before the new-messages count, which sits last (the owner on #150: "the new messages item should be last in the footer rather than being before the dots"), level with the text, the active bar included (`board/public/ui-cards.js` `phaseBars` and `timeLine`, `board/public/style.css` `.card-time .phase-bars`). The status line under the title keeps its dot and words and no longer has a line of bars under it. Opening the card takes the unread count away and leaves the bars. The owner chose take A of prototype `bars-inline-2` on #109 (11/03).

- **Only on an In Progress card with a build running.** A grill or prototype agent on a Todo card keeps its agent line and blinking dot without bars. The owner on #129: "There should not be those in to do. It should only be in progress." Orchestrator review, a builder with no phased line yet, and a card with no builder show none, as before.
- **The active bar blinks its fill, not its opacity.** It animates `background-color` to 35% notice over transparent, which draws what opacity .35 did. An opacity animation gives the bar its own compositing layer, and Safari can snap that layer a pixel off its siblings at the strip's fractional y, so the active bar sat low.

Considered:
- keeping the bars on their own line under the status line ([a building card shows its phase as five bars under its status line](2026-11-03-0458-a-building-card-shows-its-phase-as-five-bars.md)): the owner picked the bars inline at the time row's end;
- the bars after the unread count (this ADR's first order): on #150 the owner wanted the count last.

A card in orchestrator review keeps the strip with all five bars filled and none marked, so it does not blink; a build ending into review does not animate the strip out (#165, owner pick A of prototype review-bars).
