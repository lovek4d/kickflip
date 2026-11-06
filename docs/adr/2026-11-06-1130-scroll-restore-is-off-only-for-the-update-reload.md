# The browser's scroll restore is off only for the reload an update triggers

Replaces 2026-11-06-1100-the-shell-turns-off-scroll-restoration.md, which turned the restore off for good. The owner wants to keep it for ordinary reloads (#377 follow-up).

`AppShell.reload` sets `history.scrollRestoration = 'manual'` just before `location.reload()`, and puts it back to `'auto'` on `pagehide`. The setting belongs to the history entry, so the reloaded page starts at the top (the shell's `scrollTo(0, 0)`) with no old offset put back after the board grows from its saved copy, which is the likely cause of the unpainted area on iOS. Once that page is left or reloaded again, the restore is on, so ordinary reloads keep their place. Nothing forces a scroll.

Still unreproduced in the iOS Simulator: the cause is the likeliest one, not a confirmed one. If the page stays black after an update reload, the cause is something else.
