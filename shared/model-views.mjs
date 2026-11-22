// The Board defaults section's controls, drawn by ui-hub.js modelControl in Hub settings: Builders and Orchestrators,
// the hub's picks, which every board takes (docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md),
// and the Auto settings, which a board can override
// (docs/adr/2026-11-22-0130-the-auto-settings-are-hub-defaults-a-board-can-override.md).
// → {name, label, value: the choice on, choices: [{value, label, on}], description}

const NAMES = { opus: 'Opus', auto: 'Auto', sonnet: 'Sonnet', on: 'On', off: 'Off' };

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
const BUILDERS = {
  opus: 'Always Opus. Auto would give small tasks to Sonnet.',
  auto: 'Auto: small tasks get Sonnet, the rest get Opus.',
  sonnet: 'Always Sonnet. Auto would give large tasks to Opus.',
};
// Auto never switches an orchestrator: its session is long-lived, and a change reaches it only at its next start.
const ORCHESTRATORS = {
  opus: 'Each board’s own session runs on Opus. A running session takes a change when it next starts, the hub board’s at once while idle.',
  sonnet: 'Each board’s own session runs on Sonnet. A running session takes a change when it next starts, the hub board’s at once while idle.',
};

const view = (name, label, words, value) => ({
  name, label, value,
  choices: Object.keys(words).map((m) => ({ value: m, label: NAMES[m], on: m === value })),
  description: words[value],
});

// value: hub/push.mjs readClaudeModel.
export const buildersView = (value) => view('builders', 'Builders', BUILDERS, value);
// value: hub/push.mjs readOrchestratorModel.
export const orchestratorsView = (value) => view('orchestrators', 'Orchestrators', ORCHESTRATORS, value);

// The Auto settings by board.json key, in the section's order: each one's label and words for on and off.
const AUTO = {
  auto_build: ['Auto serve', {
    on: 'The hub serves each task after each push, and main after each merge.',
    off: 'Tasks wait for your Serve. Main still serves after each merge.',
  }],
  auto_review: ['Auto review', {
    on: 'When idle, Claude reviews teammates’ PRs that touch a board’s work. May use a lot of usage.',
    off: 'Claude leaves teammates’ PRs alone.',
  }],
  auto_merge: ['Auto-merge', {
    on: 'Claude merges a PR once it is approved, green and merges cleanly, and lands a build waiting to merge into the base branch.',
    off: 'Approved, green PRs and verified builds wait for your Merge.',
  }],
  idle_notification: ['Idle notification', {
    on: 'Pushes once when a board has been idle for 15 minutes, with what closed since the last one.',
    off: 'No push when a board goes idle.',
  }],
};
// defaults: shared/hub-settings.mjs readBoardDefaults. → one view per Auto setting, named by its board.json key.
export const autoViews = (defaults) => Object.entries(AUTO).map(([key, [label, words]]) => view(key, label, words, defaults[key] ? 'on' : 'off'));
