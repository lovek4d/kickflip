# Models and land tests are hub settings only

Status: accepted (owner, T-688, 11/17: "Drop both model rows; move land tests to the hub")

Supersedes [a board setting picks Opus or Sonnet for its orchestrator](2026-11-16-0945-a-board-setting-picks-opus-or-sonnet-for-its-orchestrator.md)
and [Builders and Orchestrators each take a hub default a board can override](2026-11-16-1030-builders-and-orchestrators-each-take-a-hub-default-a-board-can-override.md)
in their per-board overrides, and amends [land test runs take turns on the host](2026-11-16-0700-land-test-runs-take-turns-on-the-host.md)
in where its number is set.

The owner asked to "drop duplicate settings from board level that exist on hub, defer to hub instead".

## Decision

**Board Settings has no Builders or Orchestrators row.** Hub settings' Usage card holds the only copy:

- Builders, `settings.json` `claudeModel`, decides every board's Claude builds. `builder pick`, `builder start`'s
  refusal of a `--model` it rules out, and a helper's model read only it (`usage-gate.mjs` builderPick,
  `runs.mjs` refuseUnforced). A pick says "Claude model is …"; "This board's Claude model" is gone.
- Orchestrators, `orchestratorModel`, is the `--model` every board's session starts and resumes on
  (`sessions.mjs` common). A change reaches the hub board's idle tmux session at once by a typed `/model`, else
  any session at its next start (`sessions.mjs` changeOrchestratorModel). `/_hub/board-model/<route>`,
  `hub/board-model.mjs` and Board Settings' Restart the session now are gone, and so is `--model` on
  `kickflip join` and `kickflip start`.

**The old overrides are ignored, then cleaned up.** Nothing reads board.json `claude_model` or the manifest owner
record's `model`. A board settings save drops `claude_model` (`settings.mjs` saveBoardSettings), and a join drops the
owner record's `model` (`kickflip.mjs` join). An export no longer carries the owner's model.

**Maximum parallel land tests moves to the hub's Usage card**, a stepper beside Builders and Orchestrators posting
`/_hub/settings/land-tests` (`hub-settings.mjs` setLandTests). It was already one hub-wide number that Board Settings
showed; it leaves Board Settings, the board's `api/settings` and `settings set max-land-tests`.

**Pause board, Idle notification, Rules and Tickets stay per board.** Each is a board's own scope beside a hub one,
not a copy of it: Pause hub holds every board, the hub decides how a board's idle push is delivered, hub rules come
before a board's, and the hub holds the Linear key a board's ticket source uses.

## Consequences

- A board that had overridden a model now runs on the hub's pick from its next build or session start.
- T-545 (board settings become hub defaults with per-board overrides) has no model or land-test row to override.
