# One standard sheet size: full height on a phone, the right pane on desktop

Amended by [board settings and Repo review open centred](2026-11-25-0100-board-settings-and-repo-review-open-centred.md): from 900px the architecture review and settings are centred modals, and the pane holds the reader family only.

The standard sheet is the reader family (questions, prototypes, logs, transcripts, visuals, notes, a card page), the
architecture review (.arch-sheet) and settings (.settings-modal). Below 900px it is one height, the screen less the
status bar, standing on the bottom edge or above the app bar and keyboard (`--standard-height` in style.css, built from
#998's `--sheet-full` and `--kb`); its body scrolls inside. From 900px it is the right pane, at `--sheet-w`, stacked by
`--layer`.

Replies, New task (keyboard-sheet) and the small sheets (hold, join, links, pause, permissions, close board, main) stay
as they are, and so does the orchestrator's waits sheet. The owner: "Intentionally small modals stay small, but the
larger ones should standardize instead of having minor variances."

The hub page is the exception: it has no pane beside it, so from 900px its sheets (`.hub-modal`: a board's settings, the
closed board detail, Alerts) are centred modals with a backdrop, 680px wide at most (hub.css). Phones stay full height.
A right pane for the hub was considered and dropped: it has no persistent content to hold.
