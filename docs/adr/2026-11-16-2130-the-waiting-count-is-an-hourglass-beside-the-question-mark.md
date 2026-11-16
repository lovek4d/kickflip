# The waiting count is an hourglass beside the ?

The board header's "N waiting" chip (what waits on the orchestrator,
2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md) is now an hourglass icon button with the ?'s
number badge, always drawn. Owner's call: "Always show, even when 0 waiting".

- Placement: right of the refresh and its time, left of the ?. On a phone that reads hourglass, ?; from 900px the ? is
  hidden, so the hourglass ends the nav, right of the refresh. The header's `navStart` slot (before the controls)
  became `navAfter` (after them).
- At 0 it is the bare hourglass, no badge, and a tap opens nothing; otherwise a tap opens the same sheet as before.
- The badge reuses the ?'s badge style and takes the strongest tone the server sent (AGENTS.md colour priority): red,
  orange (the badge's default) or grey.
