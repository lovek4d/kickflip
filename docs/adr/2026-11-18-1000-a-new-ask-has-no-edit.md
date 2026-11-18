# A New ask has no Edit

Status: accepted (owner, T-693, 11/17: "drop edit from the new section (and anywhere else). delete can stay")

Supersedes [edits save when focus leaves them](2026-11-16-2000-edits-save-when-focus-leaves-them.md)
for a New ask's edit box; the rules editor keeps its own edit-on-leave.

An ask in the New strip carries Delete only. The pencil, the edit box in place of the
text, the `edit:<ask id>` composer and the page's state for open edit boxes are gone.
Edit was only ever on a New ask: no thread message, card or hub New task had one, and the
Rules editor's Edit changes a setting, not a sent message.

The board server still reads an `ask-edited` event (board/asks.mjs, domain.mjs), so an
edit already in a board's log shows its latest text marked Edited; nothing sends one now.

The edit box was the one box a board restored by its saved state when the owner left the
board and came back; a thread reply box is not drawn until its thread loads, so the return
now restores the page's scroll only.
