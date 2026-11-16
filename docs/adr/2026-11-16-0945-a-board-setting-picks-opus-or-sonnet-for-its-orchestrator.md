---
status: superseded in part by 2026-11-16-1030-builders-and-orchestrators-each-take-a-hub-default-a-board-can-override
---

# A board setting picks Opus or Sonnet for its orchestrator

Superseded in part by [Builders and Orchestrators each take a hub default a board can override](2026-11-16-1030-builders-and-orchestrators-each-take-a-hub-default-a-board-can-override.md): an empty owner record now runs on Hub settings' Orchestrators, not always Opus; Board settings' row is Orchestrators with Hub default first; New board asks no model.

The owner (T-525) asked for a "configurable option to use opus or sonnet as the board orchestrator, board level setting? Also selected on board creation. Default opus", then asked whether it "works for headless?"

**The model lives on the board's manifest owner record as `model`, as before**, and every start and foreground resume passes it as `--model`. An empty record now passes `--model opus` (`sessions.mjs` DEFAULT_MODEL), not Claude Code's default. Builders keep their own choice, the hub's Claude model setting.

**New board asks for it, Opus picked** (`new-board.mjs`, `dialogs.js`). The Starting record keeps it, so a Retry starts on the same model, and a join that arrives before the start records its session still takes it.

**Board settings has an Orchestrator model row, Opus · Sonnet, saved through the hub** (`board-model.mjs`, `/_hub/board-model/<route>`), since the owner record is the hub's manifest, not the board's board.json. When the change reaches the session depends on how the session runs:

- **The hub board** runs in the foreground in tmux. While its session reads idle, the hub types `/model <name>` into its pane, as it already types /compact, and the change applies at once. Busy or stopped, it applies when the session next starts, since a foreground resume takes `--model`.
- **Every other board** runs in the background (`claude --bg`). Claude Code 2.1.325 gives no way to type into a running background session: `attach` is interactive, and `logs`, `stop` and `respawn` send nothing. A resume can't carry a flag, which would start a copy under a new id (`resumeArgv`), and its one prompt is the rejoin. So the row says "Applies to the next new session.", and a change offers **Restart the session now**. That asks first, since the conversation ends, then stops the session and starts a fresh one on the new model that rejoins the board (`sessions.mjs` freshSession). The fresh session takes over the owner record and the old session's watcher cursor, so an event the old one hadn't heard still wakes the new one.
