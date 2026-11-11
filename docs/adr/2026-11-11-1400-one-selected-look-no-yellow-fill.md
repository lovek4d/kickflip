# One selected look, no yellow fill

A selected Needs you option (the deck's armed option, the Questions page's chosen option, the selected topic pill, including an In Progress one) uses one shared blue look, `--sel-bg` and `--sel-line` in board/public/style.css. The yellow notice fill with dark text was hard to read, and by the colour priority in AGENTS.md yellow means attention, not a plain selection.

The armed deck option keeps its Send label with a question mark, Send “…”?, as the only hint that a second tap sends (the owner's pick of three hint takes).

This supersedes 2026-11-07-0400-an-in-progress-pill-is-tinted-not-outlined.md for the selected state: an unselected In Progress pill keeps its faint orange tint, a selected one is plain blue.
