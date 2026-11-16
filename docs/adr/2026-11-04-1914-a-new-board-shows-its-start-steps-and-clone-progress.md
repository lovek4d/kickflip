# A new board shows its start steps and live clone progress

This extends [the hub starts a new board's session itself](2026-10-31-0137-the-hub-starts-a-new-boards-session.md) and [a new board chooses a repo and branch](2026-10-31-1636-a-new-board-chooses-a-repo-and-branch.md), whose Starting row read only "cloning…" then "starting…", so a large clone or a slow join looked frozen.

A starting board's sidebar row now shows its name, then three start steps on the board's own phase bars spread across the row, then the step and its seconds:

- **cloning**: the record's phase is `cloning`. Its bar fills from git's real progress, read as "cloning (42%) · 7s".
- **starting orchestrator**: the clone is done and `claude --bg` hasn't yet named the board's session.
- **landing it**: a session is recorded, until the route joins the hub.

At join the row turns into the board's clickable row, which fades in with an accent ring for a moment.

## Clone progress

The hub clones with `git clone --progress`. `runRepo`'s `onStderr` passes each stderr chunk to `cloneMeter` (`hub/repos.mjs`), which joins lines git splits across chunks or redraws after `\r`, and turns them into one percent: receiving objects is the first 90, resolving deltas the last 10. A repo that is already cloned skips that step, and its branch fetch runs during starting orchestrator.

The percent stays in hub memory (`new-board.mjs clonePercent`) only while the clone runs. The first percent calls `stream.refresh()` at once, and later ones at most once a second; the sidebar's copy carries it on the cloning row. The manifest's Starting record keeps only its coarse phase, plus `phase_at` for when the clone ended, so each step's seconds survive a hub restart. Landing counts from the record's `since`.

## The pulsing steps

Between spawning the session and its join, the hub has no signal, so starting orchestrator and landing it show the bars' running pulse, the same one an In Progress card's current build phase shows, and never a fake fill. Their seconds tick in place in `sidebar.js` each second while a start runs. A sidebar repaint would restart a CSS animation, so each repaint sets the running bar's `animation-delay` from the clock, and the pulse carries on unbroken. Real milestones for those steps are #209. Starting orchestrator now reads its session's liveness, last step and pending prompt ([a starting board shows its session's liveness, activity and prompt](2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md)).

## One renderer

`phaseBars(strip, phases)` moved out of `ui-cards.js` into `board/public/ui-phase-bars.js`, which takes the phase list and an optional `fill` percent for the next bar. Cards pass the five build phases and the sidebar passes the three start steps. It is its own file because the hub renders the shell's first sidebar in a vm context with only `ui-page-header.js` and `ui-sidebar.js`, and `ui-cards.js` needs the whole page's `BoardUI`.

The design came from prototype rounds on the card (prototypes/start-steps-7, take A).
