# A Tool use setting sets how readily the orchestrator uses tools

Status: superseded by [the orchestrator always works as High](2026-11-19-1000-the-orchestrator-always-works-as-high.md)

The owner (T-168) wanted the orchestrator "a little more proactive with using its tools" in a discussion, as a setting. Asked for the levels, they chose two, "Normal and high", and that at the higher level it "should be able to do these in general": launch a visual, grill or prototype itself.

**`tool_use` is a board setting in board.json, `normal` or `high`, `normal` when absent** (`store.mjs` settingsOf, saveBoardSettings, `settings set tool-use`). Every new and existing board starts at Normal. Anything but `high` reads as `normal`.

**The orchestrator learns it from the watcher's `setting tool-use <level>` line** (`settingsLines`), printed every wake, plus a SKILL.md paragraph saying what each level means. No wait text takes the level: the owner chose the setting line and the paragraph, so the rule stays in one place. Normal is the order SKILL.md already gave: keep discussing, a visual once the topic is complicated, a grill or prototype when asked or clearly useful. High starts a visual, grill or prototype unasked whenever it would help, and says so in the thread. Implement waits for the owner's word at both levels.

**Board settings has a Tool use row beside the Auto rows**, a segmented Normal · High control (take A of the prototype) with a help line under the title that follows the saved level. A tap saves at once.
