# The sidebar draws ctx full, host busy and paused rows as the hub sends them

From the owner's rule "There should be no guessing in general" (the T-322 audit, findings 2, 3 and 4): the sidebar worked out three marks from raw data and the colour order. The hub now sends each, and the browser draws it.

- **Context full.** Each site's `ctx` carries `full` (percent at or over 90, hub/home.mjs `CTX_FULL_PERCENT`). The dimmed "stale" mark stays in the browser: it is an age, which the owner exempts ("ages reflect stale information from the server").
- **Host busy.** `pause.machine` carries `busy` (busy for a minute and no usage pause reads first) and `banner` (busy for more than 30 minutes), from `sidebarPause`. The Hub row, the logo dot and the banner read them. The hub's sidebar poll recomputes them with its clock, so they flip when the data does.
- **Paused rows.** A board row under the hub's pause or its own arrives with its `sub.status` already grey `paused`, a red fault keeping its word (`heldSite`; the colour order in AGENTS.md). The browser no longer reads the hub pause or a row's `pause` to pick the word.
