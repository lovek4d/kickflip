# The orchestrator always works as High

Status: accepted (owner, T-758, 11/18: "Remove Tool use; the orchestrator always works as High")

Supersedes [a Tool use setting sets how readily the orchestrator uses tools](2026-11-14-1500-a-tool-use-setting-sets-how-readily-the-orchestrator-uses-tools.md).

## Decision
The per-board Tool use setting (Normal or High) is gone. The orchestrator always works as High: it starts a visual, grill or prototype unasked whenever it would help the discussion, without asking first, and says so in the thread. Implement still waits for the owner's word.

- `tool_use` leaves board settings (`settingsOf`, `saveBoardSettings`, `settings set`). `settings set tool-use` fails with the usual "no board setting" error.
- The watcher no longer prints `setting tool-use <level>`.
- Board settings has no Tool use row.
- SKILL.md's Tool use paragraph states High's rule as the standing order.
- A `tool_use` already in a board.json is dropped on the board's next settings save, as `claude_model` is; until then it sits in the file and nothing reads it.
