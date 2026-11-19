// Every recurring job the hub, its board servers, the board pages and the hooks run, one entry each: the hub's Polls
// page (/_hub/polls, hub/polls-page.mjs) is drawn from this list alone. Each timer in hub/, board/ and board/public/
// carries a `poll: <id>` comment naming its entry, on its line or the line above (`poll: none` on a helper that
// is no poll itself, such as B.every's own setInterval), and polls.test.mjs fails on a setInterval or B.every without
// one, or an entry whose file doesn't name it once
// (docs/adr/2026-11-17-0330-every-poll-is-in-one-registry-and-the-hub-runs-on-two-clocks.md).
//
// An entry is {id, group, name, what, every, runs, where, clock?, times?, cadence?, steps?}:
//   every: its period in ms, by which the page orders a group fastest first;
//   clock, times: a hub job's clock (CLOCKS) and how many of its ticks pass between runs, which hub.mjs runs it by;
//   cadence: the words for a cadence every can't say, such as one that follows the owner's presence;
//   runs: Hub, Each board, Each open page or Hook;
//   where: the repo file holding its `poll: <id>` comment, whose line the page shows;
//   steps: [{name, what?, cadence?}], what one beat does, step by step.

// The hub's clock: every recurring hub job runs on it, every `times` ticks.
export const CLOCKS = Object.freeze({ quarter: 15_000 });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const on = (clock, times) => ({ clock, times, every: CLOCKS[clock] * times });

// The groups, in page order, each with why it exists.
export const GROUPS = Object.freeze([
  { id: 'github', name: 'GitHub and PRs', why: 'What is open, red or waiting for review on GitHub.' },
  { id: 'slack', name: 'Slack', why: 'Messages sent to the hub, and replies it posts.' },
  { id: 'sessions', name: 'Sessions and prompts', why: 'Keeping board servers, Claude sessions and their prompts alive.' },
  { id: 'board', name: 'Board upkeep', why: 'What each board does on its own, once a minute.' },
  { id: 'hub', name: 'Hub upkeep', why: 'The hub’s own housekeeping.' },
  { id: 'updates', name: 'Updates', why: 'Whether there is a new version of kickflip.' },
  { id: 'pages', name: 'Pages', why: 'What each open page, and the hub for it, does to stay current.' },
  { id: 'backoff', name: 'Back-offs, not polls', why: 'Waits that only run while something is down, starting or busy.', muted: true },
]);

const PRESENCE = '1 min present · 5 min away · slower when GitHub points are low';
const QUIET_END = 'quiet hours’ end';

export const POLLS = Object.freeze([
  // GitHub and PRs
  { id: 'github-poll', group: 'github', name: 'GitHub poll and checks', what: 'Looks at PRs, checks and merges, fetches each board’s branches and pulls Main; the same poll reads Linear and sends queued pushes.',
    every: MINUTE, cadence: PRESENCE, runs: 'Hub', where: 'hub/hub.mjs' },
  { id: 'review-digest', group: 'github', name: 'Review digest', what: 'Posts each reviewer’s day digest of PRs waiting on them, weekdays only.',
    every: DAY, cadence: QUIET_END, runs: 'Hub', where: 'hub/slack.mjs' },

  // Slack
  { id: 'slack-poll', group: 'slack', name: 'Slack poll', what: 'One search per poll for @kickflip asks and replies in their threads, and posts the replies owed; rides the GitHub poll.',
    every: MINUTE, cadence: PRESENCE, runs: 'Hub', where: 'hub/hub.mjs' },

  // Sessions and prompts
  { id: 'reconcile', group: 'sessions', name: 'Reconcile', what: 'The hub’s process supervisor: starts, stops and restarts board servers (crashed, removed or changed), ends a shared page whose share was taken away, and reconnects the hub to a board’s change stream that dropped and watches each board’s watcher file, while a page is open.',
    ...on('quarter', 1), runs: 'Hub', where: 'hub/hub.mjs' },
  { id: 'hung-check', group: 'sessions', name: 'Hung boards', what: 'Restarts a board server that hasn’t answered for a minute, and pushes you if it still hasn’t 2 minutes on.',
    ...on('quarter', 1), runs: 'Hub', where: 'hub/hub.mjs' },
  { id: 'session-prompts', group: 'sessions', name: 'Session prompts', what: 'Permission prompts and questions from hub sessions. 25 s is how long one wait is held open; your answer arrives at once. Not a timer.',
    every: 25 * SECOND, cadence: '25 s hold', runs: 'Hook', where: 'hub/prompts.mjs' },
  { id: 'morning-wake', group: 'sessions', name: 'Morning wake', what: 'Wakes each board’s session once, whether GitHub changed or not.',
    every: DAY, cadence: QUIET_END, runs: 'Hub', where: 'hub/schedule.mjs' },

  { id: 'watcher-pass', group: 'sessions', name: 'Orchestrator watcher', what: 'Looks at the board’s event files for something to wake the orchestrator for, and exits when its session dies; a second 2 s pause batches events that arrive together.',
    every: 2 * SECOND, runs: 'Each board', where: 'bin/wait-events.mjs' },

  // Board upkeep
  { id: 'board-minute', group: 'board', name: 'Board minute', what: 'Everything a board checks about itself, once a minute.', every: MINUTE, runs: 'Each board', where: 'board/server.mjs',
    steps: [
      { name: 'Missed writes', what: 'a change no one told the board of reloads its pages' },
      { name: 'Overdue prototype requests' },
      { name: 'Revive a dead headless builder' },
      { name: 'Fail dead script runs' },
      { name: 'Launch lost builds' },
      { name: 'Publish unscreened grill questions' },
      { name: 'Pick-ups at their time' },
      { name: 'Re-stage stale ready cards' },
      { name: 'Pauses, auto and overnight triage' },
      { name: 'Needs-you push row' },
      { name: 'Orchestrator waits' },
      { name: 'Idle push' },
    ] },

  // Hub upkeep
  { id: 'tick', group: 'hub', name: 'Tick', what: 'The hub’s main beat. Every step runs each tick unless it has its own cadence.', ...on('quarter', 1), runs: 'Hub', where: 'hub/hub.mjs',
    steps: [
      { name: 'Try runs', what: 'worktrees, serves and Main' },
      { name: 'Route incoming asks', what: 'sorted onto boards by Haiku' },
      { name: 'Usage pause lift', what: 'resumes once the limit resets' },
      { name: 'Mac load sample' },
      { name: 'Owner presence', what: 'and starts the GitHub, Linear and Slack poll when due', cadence: PRESENCE },
      { name: 'Settle Starting boards' },
      { name: 'Morning wake', cadence: `checked every 15 s, due once a day, at ${QUIET_END}` },
      { name: 'Keep awake' },
      { name: 'npm update check', cadence: 'checked every 15 s, due every 15 min' },
      { name: 'Prune dead prompts' },
      { name: 'Session check', what: 'resumes or restarts sessions, /compact when full, logged-out push' },
    ] },
  { id: 'self-restart', group: 'hub', name: 'New hub code', what: 'Restarts the hub once its new code is whole on disk and no land is landing.',
    ...on('quarter', 1), runs: 'Hub', where: 'hub/hub.mjs' },
  { id: 'peer-outbox', group: 'hub', name: 'Asks to your other hubs', what: 'Sends again the asks and answers to another of your hubs that waited while it was offline or older, oldest first.',
    ...on('quarter', 4), runs: 'Hub', where: 'hub/hub.mjs' },
  { id: 'nightly-suite', group: 'hub', name: 'Nightly suite check', what: 'Whether tonight’s full test run is due, between the middle and end of quiet hours; on the npm check’s 15 minutes.',
    ...on('quarter', 60), runs: 'Hub', where: 'hub/hub.mjs' },

  // Updates
  { id: 'npm-update', group: 'updates', name: 'npm update check', what: 'Checks npm for a new release and pulls it once you’ve been away 15 minutes. The auto update box turns the pull off.',
    every: 15 * MINUTE, runs: 'Hub', where: 'hub/upgrade.mjs' },

  // Pages
  { id: 'start-steps', group: 'pages', name: 'Start-step ticker', what: 'Counts up a starting board’s steps in the sidebar, only while one starts.', every: SECOND, runs: 'Each open page', where: 'board/public/sidebar.js' },
  { id: 'pin-countdown', group: 'pages', name: 'Sign-in PIN countdown', what: 'Drains the Sign in a device dialog’s bar and renews its PIN at 0, only while the dialog is open.', every: SECOND, runs: 'Each open page', where: 'board/public/view-hub.js' },
  { id: 'run-log', group: 'pages', name: 'Run log', what: 'Reads a run’s log again while it’s open and the run hasn’t finished.', every: 3 * SECOND, runs: 'Each open page', where: 'board/public/app-reader.js' },
  { id: 'log-page', group: 'pages', name: 'Log page', what: 'Reads a site’s log again while the log page is open.', every: 3 * SECOND, runs: 'Each open page', where: 'board/public/log.html' },
  { id: 'page-tick', group: 'pages', name: 'Page timer', what: 'One timer per open page repaints the header’s “updated” line every 15 s, and every 30 s the “thinking…” counts, the waits sheet’s ages and the hub page’s refresh.', every: 15 * SECOND, runs: 'Each open page', where: 'board/public/app.js' },
  { id: 'down-check', group: 'pages', name: 'Down-check, stream down', what: 'Reloads the board only while the page’s stream is down: one check on the page timer.', every: 15 * SECOND, runs: 'Each open page', where: 'board/public/app.js' },
  { id: 'sidebar-refresh', group: 'pages', name: 'Sidebar refresh', what: 'Sends open pages the board list again.', ...on('quarter', 1), runs: 'Hub', where: 'hub/hub.mjs' },
  { id: 'stream-ping', group: 'pages', name: 'Hub stream ping', what: 'Keeps Tailscale Serve from idling an open page’s stream out.', every: 25 * SECOND, runs: 'Hub', where: 'hub/stream.mjs' },

  // Back-offs, not polls
  { id: 'board-asks-wait', group: 'backoff', name: 'asks --wait', what: 'only while a board’s ask to another board is unanswered; gives up after 9 min and is run again', every: 2 * SECOND, runs: 'Each board', where: 'board/asks.mjs' },
  { id: 'helper-wait', group: 'backoff', name: 'agent wait', what: 'only while a builder’s helper runs; gives up after 9 min and is run again', every: 2 * SECOND, runs: 'Each board', where: 'board/runs.mjs' },
  { id: 'builder-asks-wait', group: 'backoff', name: 'builder asks --wait', what: 'only while a builder’s ask waits on the orchestrator; gives up after 9 min and is run again', every: 2 * SECOND, runs: 'Each board', where: 'board/runs.mjs' },
  { id: 'try-group-wait', group: 'backoff', name: 'Try run stop wait', what: 'only while a stopped try run’s processes are exiting', every: 20, runs: 'Hub', where: 'hub/try.mjs' },
  { id: 'agent-session-wait', group: 'backoff', name: 'Agent session wait', what: 'only while a starting agent hasn’t named its session yet', every: 100, runs: 'Each board', where: 'board/agents.mjs' },
  { id: 'try-port-wait', group: 'backoff', name: 'Try run port wait', what: 'only while a try run starts', every: 250, runs: 'Hub', where: 'hub/try.mjs' },
  { id: 'try-relay-wait', group: 'backoff', name: 'Try relay port wait', what: 'only while another process holds a starting try run’s port, 15 s at most', every: 250, runs: 'Hub', where: 'hub/try.mjs' },
  { id: 'restart-hub-wait', group: 'backoff', name: 'Hub restart wait', what: 'only after Restart hub, until it’s back, 2 minutes at most', every: SECOND, runs: 'Each open page', where: 'board/public/view-hub.js' },
  { id: 'stream-reopen', group: 'backoff', name: 'Stream reopen', what: 'only while the page’s hub stream is closed', every: SECOND, cadence: '1 s → 30 s', runs: 'Each open page', where: 'board/public/shell.js' },
  { id: 'test-run-watch', group: 'backoff', name: 'Test run watch', what: 'only while a test run’s processes run; each exits once its run is gone', every: SECOND, runs: 'Each board', where: 'board/exit-with-run.mjs' },
  { id: 'permission-hook-retry', group: 'backoff', name: 'Permission hook retry', what: 'only while the hub is down; a session waiting on a prompt sleeps between tries', every: 2 * SECOND, runs: 'Hook', where: 'hub/permission-hook.mjs' },
  { id: 'lock-heartbeat', group: 'backoff', name: 'Lock heartbeat', what: 'only while a lock is held, such as a clone or a ticket write', every: 5 * SECOND, runs: 'Hub', where: 'hub/locks.mjs' },
  { id: 'down-retry', group: 'backoff', name: 'Retries while a board is down', what: 'only while the board doesn’t answer', every: 5 * SECOND, runs: 'Each open page', where: 'board/public/app.js' },
  { id: 'settings-retry', group: 'backoff', name: 'Settings retry', what: 'only while Board settings shows a saved copy', every: 5 * SECOND, runs: 'Each open page', where: 'board/public/view-settings.js' },
  { id: 'test-progress', group: 'backoff', name: 'Test run progress', what: 'only while a test run runs', every: 2 * MINUTE, runs: 'Each board', where: 'board/worktree.mjs' },
]);

const UNITS = [[DAY, 'day'], [60 * MINUTE, 'h'], [MINUTE, 'min'], [SECOND, 's'], [1, 'ms']];
// A period in ms as words: 250 → "250 ms", 15000 → "15 s", 900000 → "15 min".
export function spanWords(ms) {
  const [size, unit] = UNITS.find(([u]) => ms >= u && ms % u === 0) || [1, 'ms'];
  return `${ms / size} ${unit}`;
}

// An entry's cadence as the page shows it: its own words, else "every 2 s", with a hub clock job's ticks after it
// when they are more than one: "every 15 min (60 × 15 s)".
export function cadenceOf(poll) {
  if (poll.cadence) return poll.cadence;
  const every = `every ${spanWords(poll.every)}`;
  return poll.clock && poll.times > 1 ? `${every} (${poll.times} × ${spanWords(CLOCKS[poll.clock])})` : every;
}

// The hub jobs due on a clock's nth tick, counting from 1.
export const dueOn = (clock, n) => POLLS.filter((p) => p.clock === clock && n % p.times === 0);
