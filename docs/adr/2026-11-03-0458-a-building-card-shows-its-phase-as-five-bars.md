# A building card shows its phase as five bars under its status line

Superseded by [a building card's phase bars end its time row](2026-11-03-1519-a-building-cards-phase-bars-end-its-time-row.md): the bars sit at the end of the card's time row, and only on an In Progress card with a build running.

This supersedes [a builder status line is a phase and a short detail](2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md) in part, on how the card shows the phase. The phases and the status line stay as [a builder status line is a phase and a short detail](2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md) has them.

While a builder runs, its card gets a second line under the status line: five short bars, one per phase (reading, building, testing, checking, landing). Finished phases are filled, the current one is filled and pulses, the rest stay grey (`board/public/ui-cards.js` `phaseBars`, `board/public/style.css` `.phase-bars`). The status line keeps its phase word and detail ("Testing · <detail> · 3m ago"). The owner chose take B of prototype `phase-dots` on #43 (11/03): "Drop the bars below the status line, so it's on a new line below the actual status."

- **Only while a builder runs with a phase.** `builderOf` carries `phase`, the newest status line's phase since the earliest running agent started (`board/domain.mjs`). No bars before the first phased line, after a line with no phase, for a card in Orchestrator review, or for a queued or blocked build, which have no builder line.
- **Thread status lines stay words.** The bars are on the card only.
- **Reads as text for a screen reader.** The strip is an image labelled "Testing, step 3 of 5".

Considered:
- the bars replacing the phase word on the status line: the owner wanted the line unchanged and the bars below it;
- bars on every card with a builder, Orchestrator review included: the owner wanted none there.

Since #695 a builder runs only the tests it writes or changes, the land runs the affected set once after its rebase, and In Progress has four steps, testing gone ([builders run only their own tests; the land runs affected once](2026-11-14-0600-builders-run-only-their-own-tests-and-the-land-runs-affected-once.md)).
