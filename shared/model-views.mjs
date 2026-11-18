// The Builders and Orchestrators controls, drawn by ui-hub.js modelControl in Hub settings' Usage card: the hub's
// picks, which every board takes (docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md).
// → {name, label, value: the choice on, choices: [{value, label, on}], description}

const NAMES = { opus: 'Opus', auto: 'Auto', sonnet: 'Sonnet' };

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
