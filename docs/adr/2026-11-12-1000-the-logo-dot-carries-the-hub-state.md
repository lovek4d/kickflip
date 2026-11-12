# The logo dot carries the hub state; refresh is never coloured

Status: accepted (owner, 11/11 23:44, card #581). Amends 2026-11-06-1305-a-busy-host-shows-only-on-the-hub-row-and-the-logo-dot.md and the watcher-health part of 2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md.

The header's time and refresh arrow turned red when Claude stopped listening or the page lost the host, while the logo's dot showed busy and update. Two places said the hub's state.

Now the kickflip logo carries one dot, the highest colour that applies (AGENTS.md colour order):
- red: Claude not listening on any board (a board's listen state is deaf or context full), a site down, or this page can't reach the host. The page sets the last one itself (`link-offline` on `<html>`), since a dot that comes from the hub can't report the hub's outage.
- orange: the host is busy.
- blue: a new version is ready.
- grey: paused (a usage pause, Pause hub or Pause board). It used to show on the header only as an amber banner; a pause no longer hides behind busy.

The hover text on the logo says which.

The header's time and refresh arrow are never coloured; their title keeps the reason. The pause banner stays.

The sidebar's site rows now carry `listen`, so the page can tell a board that isn't listening without asking again.
