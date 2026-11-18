---
status: superseded in part by 2026-11-18-0800-models-and-land-tests-are-hub-settings-only
---

# Builders and Orchestrators each take a hub default a board can override

Superseded in part by [models and land tests are hub settings only](2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md): the hub's two controls stay, and no board overrides them.

The owner (T-529), on T-525's per-board orchestrator model, wondered whether it "should also be a hub level setting and maybe even just fall into the existing three-way selection we have of Opus, Auto, and Sonnet", then picked two separate toggles, and noted: "Each board can override both settings. Dry copy the same toggles into each board." Asked whether Auto should switch orchestrators near the usage pause line: no, orchestrators stay put. And for New board: "Skip on new board".

**Hub settings' Usage card opens Claude's block with two controls: Builders, Opus · Auto · Sonnet, and Orchestrators, Opus · Sonnet.** Builders is the hub's Claude model as before (`settings.json` `claudeModel`, default Auto). Orchestrators is new (`orchestratorModel`, default Opus): the model each board's own session starts on. Auto has no say over orchestrators, since a session is long-lived and a change reaches it only at a start.

**Board settings draws the same two controls, each with Hub default (<the hub's model>) first.** One server module builds both pages' views (`shared/model-views.mjs`), and one renderer draws them (`ui-hub.js` modelControl), so the board's copy is the hub's, not a second one.

- **Builders' override is board.json `claude_model`**, saved through the board's `POST api/settings` and `settings set claude-model hub|opus|auto|sonnet`. `builder pick`, `builder start`, a helper's model and a forced `--model`'s refusal read it before the hub's (`usage-gate.mjs` claudeModelFor), and a pick on it says "This board's Claude model is …".
- **Orchestrators' override is the manifest owner record's `model`**, as T-525 kept it, saved through the hub (`/_hub/board-model/<route>`, `{model: opus | sonnet | null}`); none is Hub default. Each start passes `--model` the override, else the hub's choice (`sessions.mjs` common). A start no longer writes the model it resolved back onto the record (`startSession` answers the override or null), so a board on Hub default stays on it.

**A change of the hub's Orchestrators reaches boards as a board's own change does** ([a board setting picks Opus or Sonnet for its orchestrator](2026-11-16-0945-a-board-setting-picks-opus-or-sonnet-for-its-orchestrator.md)): the hub board on Hub default, idle in tmux, gets `/model` typed at once; any other board's background session takes it at its next new session. Board settings now offers Restart the session now on every background board, not only after a change made there, since a hub change made elsewhere needs it too.

**New board asks no model.** T-525's Opus · Sonnet choice there is gone; a new board starts on Hub default for both, changed later in Board settings.

Boards made between T-525 and this change recorded `model: opus` on their owner record when they started, which now reads as an Opus override, not Hub default; Hub default in their Board settings clears it.
