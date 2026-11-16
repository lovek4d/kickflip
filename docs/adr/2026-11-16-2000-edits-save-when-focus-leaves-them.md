# Edits save when focus leaves them

The owner wanted text areas to save on blur everywhere. Two kinds of text area exist: edits of a saved value, and composers that send. Sending on blur would post half-written messages, so only edits change; composers keep their Send and their drafts. Saving composer drafts and question picks on the server is its own task (#535).

## Decision

- **A New-strip ask's edit box** (`ui-cards.js` `editForm`, `app-asks.js`) has no Save or Cancel. When focus leaves the form, the edit goes through the outbox as before. Focus moving to the form's own attach button or file list doesn't count as leaving. An emptied text, or an unchanged one with no files attached, closes the box and sends nothing; Escape closes it and sends nothing. An upload still running holds the save: the box stays open and the next blur saves.
- **The rules editor** (`board/public/rules-editor.js`, on Board Settings and the Hub page) has no Save, Done or Cancel. A rule's edit saves when its box loses focus (Enter does the same), an added rule saves when the add box loses focus or on Enter or Add, and a removal saves at once. With no batch to hold, the staged states (edited, new, removed with Undo) are gone. A refused save keeps the box and what was typed, and the status line says why. Emptied, unchanged and Escaped edits save nothing.
- Each save still sends the whole list with the ids the page loaded, so `hub/rules.mjs` `applyRules` merges as before; a change now sends one `rules` event per edit, not one per Save.

This supersedes "Both editors stage edits until Save" in 2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md.

Board Settings' Description row (T-528) isn't built yet; it saves on blur when it is.
