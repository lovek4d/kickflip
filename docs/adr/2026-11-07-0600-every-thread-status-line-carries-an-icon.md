# Every thread status line carries an icon, and a test enforces it

Status: accepted

Moved, visual and re-ask lines had no mark or an empty one, so their text sat off the column the other lines use.

Every system line in a thread now leads with a mark. `ui.js` MARK_ICONS holds an icon for each word domain.mjs puts on a request line or footer, plus `ask-link` (a move or add) and `visual`. Builder status and agent lines keep their working and agent dots: a dot shows a live builder (see 2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).

`ui.test.mjs` renders each kind in `SYSTEM_KINDS` (ui-threads.js) and each label from domain.mjs, and fails when a mark is empty. A new kind goes in SYSTEM_KINDS with an icon in MARK_ICONS.
