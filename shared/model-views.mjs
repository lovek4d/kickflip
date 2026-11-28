// The Board defaults section's controls, drawn by ui-hub.js modelControl in Hub settings: Builders and Orchestrators,
// the hub's picks, which every board takes (docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md),
// and the Auto settings and Pull in issues, which a board can override
// (docs/adr/2026-11-22-0130-the-auto-settings-are-hub-defaults-a-board-can-override.md).
// → {name, label, value: the choice on, choices: [{value, label, on}], description}

const NAMES = { opus: 'Opus', auto: 'Auto', sonnet: 'Sonnet', on: 'On', off: 'Off', assigned: 'Assigned only', all: 'All', oldest: 'Oldest first', newest: 'Newest first' };

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

// docs/adr/2026-11-28-0300-a-hub-setting-orders-the-pull.md
const PULL_ORDER = {
  oldest: 'Each board pulls its topmost Ready task first, the oldest by creation. Bumped tasks still go first.',
  newest: 'Each board pulls the Ready task readied last first, and its Ready lane lists it on top. Bumped tasks still go first.',
};
// value: hub-settings.mjs readPullOrder.
export const pullOrderView = (value) => view('pull_order', 'Pull order', PULL_ORDER, value);

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
  // docs/adr/2026-11-22-2221-an-approved-tasks-splits-land-in-todo-as-staging.md
  stage_splits: ['Automatically stage split tickets', {
    on: 'When the orchestrator splits a task you approved, each split lands in Todo as staged, skipping New.',
    off: 'Each split of a task you approved comes in as an ask through New, which the orchestrator sorts.',
  }],
  // docs/adr/2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md
  pull_issues: ['Pull in issues', {
    off: 'Issues come onto a board only when you add them.',
    assigned: 'The hub files each open issue assigned to you on a board’s GitHub repo that no task names, as a task to discuss.',
    all: 'The hub files each open issue on a board’s GitHub repo that no task names, as a task to discuss.',
  }],
};
// defaults: shared/hub-settings.mjs readBoardDefaults. → one view per Auto setting, named by its board.json key, its
// value on or off, or the word a setting with choices holds.
export const autoViews = (defaults) => Object.entries(AUTO).map(([key, [label, words]]) => view(key, label, words, typeof defaults[key] === 'boolean' ? (defaults[key] ? 'on' : 'off') : defaults[key]));
