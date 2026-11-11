# A board row keeps its last needs answer and goes gray when stale

A board's `GET /_claude/needs` read that fails or runs over 1.5 s used to be cached as `null` for 20 s, so the sidebar row lost its status line and lane chips (only ctx stayed). The hub now keeps each board's last good answer (`holdNeeds` in hub/home.mjs, `goodNeeds` in hub/hub.mjs) and shows it while a read fails. The held answer still counts toward the logo count and the app badge.

Fifteen seconds after that last good read, while the newest read has still failed, the row's line goes flat gray with `(stale)` after its word, e.g. `● working (stale)` (prototype take A). A fresh read clears it. A dropped device stream does not stale rows: the header's yellow refresh covers that, and "stale" on an item otherwise means its own builder is stalled.

This bends AGENTS.md's colour priority on a stale row: gray hides a red chip there. CONTEXT.md's Colour rule says so.
