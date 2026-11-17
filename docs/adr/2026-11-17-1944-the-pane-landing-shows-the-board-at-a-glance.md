# The pane landing shows the board at a glance under its chips

From 900px, with no sheet open, the pane's landing (the board's name, one line and the filter chips;
2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md) carries the board at a glance under the chips, in three
blocks of one-line rows (board/public/app-pane.js glanceHtml):

- **Lanes**: a line per lane in the board's own order, with a short breakdown (Todo's ready, discussing and blocked
  counts from the filter's boxes; In Progress's building, landing, blocked and paused; In Review's to review; Done's
  landed today) and the lane header's own count, "x of y" while the filter, the search or a chain narrows it
  (app-lanes.js laneCards, which both draw from). Its mark is the highest colour among the lane's cards (AGENTS.md).
  A tap opens the lane if shut and scrolls the board to it.
- **Building**: every In Progress card, red (a fault: stalled, rebase failed, land failed, refused, logged out) first,
  then orange (its phase, Checking, Landing, or "Blocked by …"), then grey (paused, stopped), each colour by when its
  build started so a row keeps its place. Six at most, then "+N more in In Progress", which scrolls to the lane.
- **Landed**: the last three cards that landed (a commit, green) or merged (purple) today on this device's clock,
  newest first, with how long ago. A card closed without landing isn't one.

A building or landed row selects its card (app-selection.js select), as the waits sheet's rows do. Building and
Landed show the whole board whatever the filter hides: they are its activity, not a to-do list. A block with nothing
to show keeps its heading and one grey line. The glance repaints in renderPane with the lanes on every board change,
its rows keyed by card so one that stays is untouched; a row new since the last paint washes orange in Building and
green in Landed for 1.6 s.

The data is what `api/board` sends, with one field added to a Done card's slim copy: `commit`
(domain.mjs DONE_FIELDS). Without it a landed card and one closed unlanded look the same on the page. A Done card's
`sortAt` is when it closed (domain.mjs SORT_AT), so the glance reads that in place of `closedAt`, which the slim copy
leaves out. Sending `commit` also gives a Done card the commit chip and Commit row its markup already draws.

The visual named the build steps "Building, Testing, Landing"; the glance uses the board's own phases (reading,
building, checking, landing; ui-enums.js PHASES), since the card's phase bars read them.
