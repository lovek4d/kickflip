// The Builders and Orchestrators controls, drawn by ui-hub.js modelControl in Hub settings' Usage card and in each
// board's Board settings (docs/adr/2026-11-16-1030-builders-and-orchestrators-each-take-a-hub-default-a-board-can-override.md).
// The hub's view of each lists its models; a board's lists Hub default (<the hub's model>) first, value hub, then the
// same models. → {name, label, value: the choice on, model: the model it gives, choices: [{value, label, on}], description}

const NAMES = { opus: 'Opus', auto: 'Auto', sonnet: 'Sonnet' };
export const HUB_DEFAULT = 'hub';

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
const BUILDERS = {
  opus: 'Always Opus. Auto would give small tasks to Sonnet.',
  auto: 'Auto: small tasks get Sonnet, the rest get Opus.',
  sonnet: 'Always Sonnet. Auto would give large tasks to Opus.',
};
// Auto never switches an orchestrator: its session is long-lived, and a change reaches it only at its next start.
const SWITCH = 'A running session takes a change when it next starts, or now from its Board settings.';
const ORCHESTRATORS = {
  opus: `Each board’s own session runs on Opus unless its Board settings pick another. ${SWITCH}`,
  sonnet: `Each board’s own session runs on Sonnet unless its Board settings pick another. ${SWITCH}`,
};
const BOARD_ORCHESTRATORS = {
  opus: 'This board’s own session runs on Opus, whatever Hub settings pick.',
  sonnet: 'This board’s own session runs on Sonnet, whatever Hub settings pick.',
};

// hub: the hub's choice; board: undefined for the hub's own view, else the board's override or null on Hub default.
function view(name, label, words, { hub, board, boardWords = words, follows = (m) => `Follows Hub settings. ${words[m]}` }) {
  const models = Object.keys(words);
  const value = board === undefined ? hub : board ?? HUB_DEFAULT;
  const choices = [...(board === undefined ? [] : [{ value: HUB_DEFAULT, label: `Hub default (${NAMES[hub]})` }]), ...models.map((m) => ({ value: m, label: NAMES[m] }))]
    .map((c) => ({ ...c, on: c.value === value }));
  const description = board === undefined ? words[hub] : board ? boardWords[board] : follows(hub);
  return { name, label, value, model: board || hub, choices, description };
}

// hub: hub/push.mjs readClaudeModel; board: board.json claude_model.
export const buildersView = (hub, board) => view('builders', 'Builders', BUILDERS, { hub, board });
// hub: hub/push.mjs readOrchestratorModel; board: the manifest owner record's model.
export const orchestratorsView = (hub, board) => view('orchestrators', 'Orchestrators', ORCHESTRATORS, { hub, board, boardWords: BOARD_ORCHESTRATORS, follows: (m) => `Follows Hub settings: ${NAMES[m]}.` });
