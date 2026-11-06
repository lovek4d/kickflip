# A progress bar pulses one step at a time, from one component every bar shares

The owner (#330, 11/05), verbatim: "Only one of the dots in the progress bar should be able to pulse at a time. Dry so all use cases get matched behavior. Simplify the api for that component"

The owner saw steps 2 and 4 of a card pulse together. In the code, a strip drew at most one `now` bar, but a building card's bar and its status-line dot each pulsed on their own beat, and the card's bar restarted its beat on every lanes redraw. Only the sidebar lined its bars up with the clock, with its own loop.

- `board/public/ui-progress-bar.js` (was `ui-phase-bars.js`) is the one component: `BoardUI.progressBar({count, done, now, percent, dim, tone, label})`, or null for no bar. `done` counts the steps reached, filled; `now` is the index of the one running step, which pulses. One index means a bar cannot draw two pulsing steps. `percent` fills the step after the done ones (a starting board's clone). `tone: 'plan'` draws the planner blue. Its callers are ui-cards.js `phaseStrip` (In Progress build phases, Todo planner dashes) and ui-sidebar.js `startSteps`. The old `phaseBars(strip, phases)` took a phase list only to count it, and `reached` plus `running` to say which bar runs; `count` and `now` replace them.
- A dim bar writes its running step as `done`, so the markup decides it doesn't pulse; style.css lost its `:not(.dim)`.
- One clock for every pulse (owner, gh330-one-clock, and gh330-proto-pick: "Both, on one clock"): `BoardUI.onePulse` listens for `animationstart` on the document and sets each pulse animation (`pulse`, `pulse-fill`, `pulse-fill-plan`, `sb-pulse`, `reader-pulse`) to start at the document timeline's origin. Every pulse on the page then shares one phase, so a card's running bar and its status dot blink together, and a redrawn copy picks up the beat instead of restarting it. sidebar.js's own `animationDelay` loop for a starting board's bar went.
- app-cards.js `moveStrips` keys its enter, fill and leave motion off `done`, which counts what `reached` did.
- Colours and names stay as they were: #324 reviews them.
