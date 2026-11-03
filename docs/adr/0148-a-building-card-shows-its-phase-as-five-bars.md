# A building card shows its phase as five bars under its status line

Superseded by [0160](0160-a-building-cards-phase-bars-end-its-time-row.md): the bars sit at the end of the card's time row, and only on an In Progress card with a build running.

This supersedes [0137](0137-a-builder-status-line-is-a-phase-and-a-short-detail.md) in part, on how the card shows the phase. The phases and the status line stay as 0137 has them.

While a builder runs, its card gets a second line under the status line: five short bars, one per phase (reading, building, testing, checking, landing). Finished phases are filled, the current one is filled and pulses, the rest stay grey (`board/public/ui-cards.js` `phaseBars`, `board/public/style.css` `.phase-bars`). The status line keeps its phase word and detail ("Testing · <detail> · 3m ago"). The owner chose take B of prototype `phase-dots` on #43 (11/03): "Drop the bars below the status line, so it's on a new line below the actual status."

- **Only while a builder runs with a phase.** `builderOf` carries `phase`, the newest status line's phase since the earliest running agent started (`board/domain.mjs`). No bars before the first phased line, after a line with no phase, for a card in Orchestrator review, or for a queued or blocked build, which have no builder line.
- **Thread status lines stay words.** The bars are on the card only.
- **Reads as text for a screen reader.** The strip is an image labelled "Testing, step 3 of 5".

Considered:
- the bars replacing the phase word on the status line: the owner wanted the line unchanged and the bars below it;
- bars on every card with a builder, Orchestrator review included: the owner wanted none there.
