// docs/adr/2026-11-17-2345-a-board-launched-run-lives-in-one-runs-module.md
// A run the board launches on a card (CONTEXT.md Builder, Landing, Rebase run, Helper, a planner or visual agent): how
// it starts, relaunches, stops and finishes, and the four run-state files that track it, all in one module. The
// launcher is injected (io.launch, agents.mjs launchAgent's arguments and answer), as startServer({launch}) takes it, so
// a run's lifecycle runs under a fake launcher with no server.
//
// The interface:
// - start(site, key, kind, io): opens a run's record and launches it (a build, a grill or prototype, a visual or
//   reviewer, a helper).
// - stop(site, key, {kill}): with kill, the orchestrator's builder stop of the card's board-launched run; without, the
//   close of an agent's own record (the SubagentStop hook, a closed board).
// - finish(site, key, flags): builder done's close of a helper, planner or builder record that hands back no card.
// - alive(site): the snapshot's {<key>: true | false | 'held'} of each run's process.
// - tick(site, built, io, due): the board's launch passes, as one call on each Auto check.
// - revive(site, read, io, {boot}): the minute's relaunch of a dead builder and launch of a lost one; at boot, a
//   cut-off one.
//
// io is the server's: {launch, log(entry) the audit log, stale() drops its cached board, event(kind, data) appends an
// event, home}. A pass returns {held}: whether a launch it would make found the board's launches held (heldFor), so the
// minute check brings in the next pass once the hold lifts.
//
// The run-state files, in data/:
// - headless-builders.json {<key>: {kind, model, pid, log, relaunched, handedBack?}}: each headless builder launched, pid
//   null while a hold keeps its launch (docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md).
// - landers.json {<key>: {verified, pid, log, relaunched, handedBack?, limited?}}: the lander of each verification
//   (docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md).
// - rebases.json {<key>: {conflict, pid, log?, relaunched?, handedBack?, limited?}}: the rebase run of each conflict
//   (docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md).
// - queued-planners.json {<key>#<kind>: {kind, kept?, until?}}: the planners a hold or the usage limit keeps waiting.
// The record writes themselves (agents/<id>.json) stay in store.mjs beside the card and question writes they share
// helpers with; nothing outside store.mjs and this module calls them to start, stop or finish a run.
import os from 'node:os';
import path from 'node:path';
import { editJSON, readJSON, writeJSON } from './files.mjs';
import * as store from './store.mjs';
import { agentMayRun, hasBuilder, landByBuilder, launchBuilder, launchedAgents, pidAlive, rerunBrief, resumeBrief, resumeBuilder, runFailure, stopRuns } from './headless.mjs';
import { beside, briefsDue, LANDER, landSkipOf, landStep, PAUSE_CLEARS, plans, providerOf, queuedPlannerCard, queuedPlannerKey, rebasesDue, stoppedWords, VISUAL } from './domain.mjs';
import { boardWorktree, builderRepo, clearStoppedLand, helperWorktree, prWorktree } from './worktree.mjs';
import { heldFor, launchHeldWords, pauseReasonFor, readUsageGate } from '../shared/usage-gate.mjs';
import { runLimit } from '../hub/usage.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { processStarts } from '../hub/live.mjs';

const fileOf = (site, name) => path.join(site, 'data', name);
const TRACKED = 'headless-builders.json';
const LANDERS = 'landers.json';
const REBASES = 'rebases.json';
const QUEUED = 'queued-planners.json';

const fail = (msg) => { throw new store.BoardError(msg); };
const quiet = { log: () => {}, stale: () => {}, event: async () => {} };
const ioOf = (io) => ({ ...quiet, home: os.homedir(), ...io });

// The board's launches of kind are held now (shared/usage-gate.mjs heldFor), marked on the pass.
function heldNow(site, pass, kind = 'claude') {
  const held = heldFor(readUsageGate({ dir: site }), kind);
  if (held) pass.held = true;
  return held;
}

// ---- The run-state files ----

// trackLaunch sets a key's headless-builders.json entry, or with null drops it (a lander takes the card over from its builder).
async function trackLaunch(site, key, entry) {
  await editJSON(fileOf(site, TRACKED), (tracked) => { if (entry) tracked[key] = entry; else delete tracked[key]; });
}

// data/landers.json, each entry read with whether its process lives (alive) and, once gone, whether its run ended on
// the usage limit (limited), as landStep reads them. An entry from before landers kept their pid is a verification alone.
export async function readLanders(site) {
  return Object.fromEntries(Object.entries(await readJSON(fileOf(site, LANDERS), {})).map(([key, v]) => {
    const entry = typeof v === 'string' ? { verified: v, pid: null } : v;
    const alive = Number.isInteger(entry.pid) && pidAlive(entry.pid);
    return [key, { ...entry, alive, limited: !alive && (Boolean(entry.limited) || (Boolean(entry.log) && Boolean(runLimit(entry.log)))) }];
  }));
}

// data/queued-planners.json, as the snapshot shows it.
export const queuedPlanners = (site) => readJSON(fileOf(site, QUEUED), {});

const queuePlanner = (site, key, kind, entry) => editJSON(fileOf(site, QUEUED), (queued) => { queued[queuedPlannerKey(key, kind)] = { kind, ...entry }; });

// docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md
// {<key>: whether its headless process lives}: a card's tracked builder, else its lander (domain.mjs builderOf). A gone
// process reads false only once the board has stopped relaunching it (handedBack, revive); before that the next
// minute's pass relaunches it, as tick does a lander, so it reads as untracked. A builder whose launch a hold keeps
// (pid null) reads 'held' until revive launches it. A rebase run reads the same way from data/rebases.json.
export async function alive(site) {
  const map = Object.create(null);
  const headless = await readJSON(fileOf(site, TRACKED), {});
  const landers = await readLanders(site);
  const rebases = await readJSON(fileOf(site, REBASES), {});
  for (const [key, entry] of [...Object.entries(landers), ...Object.entries(rebases), ...Object.entries(headless)]) {
    if (entry?.pid === null && routeRecord(headless, key) === entry) map[key] = 'held';
    if (!Number.isInteger(entry?.pid)) continue;
    if (pidAlive(entry.pid)) map[key] = true;
    else if (entry.handedBack) map[key] = false;
    else delete map[key];
  }
  return map;
}

// ---- Starting a run ----

// What a start came to, for the audit log: started, bumped behind its blockers, or refused.
export const startResult = (started) => (!started ? 'refused' : started.bumped ? 'bumped' : 'started');

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A build started ({key, kind, model, worktree}, store.mjs startTappedBuild's) launches its builder, Claude or Codex. A
// launch that fails puts the card back in Todo with the reason (store.mjs abandonLaunch). A pause on its kind or a busy
// host that began after the pull or the tap holds the launch, tracked with pid null; revive launches it once the hold
// lifts. A busy Mac says so on the card (docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md).
async function handOff(site, started, io) {
  io.stale();
  if (!started || started.bumped) return;
  const entry = { kind: started.kind, model: started.model, relaunched: false };
  try {
    const gate = readUsageGate({ dir: site });
    if (heldFor(gate, started.kind)) {
      io.log({ call: 'launch-held', key: started.key, result: 'held', reason: pauseReasonFor(gate, started.kind), inputs: { kind: started.kind, model: started.model ?? null, gate } });
      if (gate.machine.state === 'busy') await store.appendStatus(site, started.key, 'host-busy');
      await trackLaunch(site, started.key, { ...entry, pid: null });
    } else {
      const { pid, log } = await launchBuilder(site, started, { launch: io.launch });
      await trackLaunch(site, started.key, { ...entry, pid, log });
    }
  } catch (e) {
    await store.abandonLaunch(site, started.key, `the launch failed: ${e.message}`);
  }
}

// A planner, kind grill or prototype, opens on the card from its written brief, or from kept, the briefs entry of the
// run a Block stopped, and launches headless in the board's repo (store.mjs startPlanner), unless an agent already works
// on it. One that can't start or launch leaves a thread line and its record closed. One due while the board's launches
// are held waits in queued-planners.json, with a thread line saying so, and launches when the hold lifts
// (launchQueuedPlanners); another of the same kind on the card replaces it.
// (docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md)
async function launchPlanner(site, key, kind, kept, io, pass) {
  const gate = readUsageGate({ dir: site });
  if (heldFor(gate, 'claude')) {
    pass.held = true;
    await queuePlanner(site, key, kind, kept ? { kept } : {});
    io.log({ call: 'planner-queued', key, result: kind, reason: pauseReasonFor(gate, 'claude'), inputs: { kind, gate } });
    await store.appendStatus(site, key, gate.machine.state === 'busy' ? 'host-busy' : 'planner-held', { kind });
    return;
  }
  try {
    const started = await store.startPlanner(site, key, kind, kept);
    if (!started) return;
    try { await launchBuilder(site, started, { launch: io.launch }); } catch (e) {
      await store.abandonPlanner(site, key, ['planner-failed', { kind, error: e.message }]);
    }
  } catch (e) {
    if (!(e instanceof store.BoardError)) throw e;
    await store.appendStatus(site, key, 'planner-failed', { kind, error: e.message });
  }
}

// A visual agent or reviewer, headless in the board's repo beside whatever else runs on the card
// (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md, store.mjs startVisual). One that can't
// start or launch leaves a thread line and its record, if any, closed.
async function launchBeside(site, key, kind, io) {
  const named = kind === VISUAL ? 'visual agent' : kind;
  try {
    const started = await (kind === VISUAL ? store.startVisual : store.startReviewer)(site, key);
    if (!started) return;
    try { await launchBuilder(site, started, { launch: io.launch }); } catch (e) {
      await store.abandonPlanner(site, key, ['planner-failed', { kind: named, error: e.message }], started.agent);
    }
  } catch (e) {
    if (!(e instanceof store.BoardError)) throw e;
    await store.appendStatus(site, key, 'planner-failed', { kind: named, error: e.message });
  }
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// A requested helper (name) opens its record (store.mjs startHelper), one that writes in its own worktree off the card's
// branch, and launches headless. One that can't start or launch leaves a thread line and its record closed, which its
// spawner's agent wait reports.
async function launchHelper(site, key, name, io) {
  try {
    const started = await store.startHelper(site, key, name, (opts) => helperWorktree(key.split('/')[1], name, opts));
    if (!started) return;
    io.log({ call: 'helper', key, result: 'launching', reason: 'A helper was asked for and pullOf let it launch.', inputs: { name, model: started.model, worktree: started.worktree } });
    try { await launchBuilder(site, started, { launch: io.launch }); } catch (e) {
      await store.abandonPlanner(site, key, ['helper-failed', { name, error: e.message }], name);
    }
  } catch (e) {
    if (!(e instanceof store.BoardError)) throw e;
    await store.abandonPlanner(site, key, ['helper-failed', { name, error: e.message }], name);
  }
}

// Starts a run of kind on the card and launches it:
// - build: the build's record (store.mjs startTappedBuild, dispatched by io.dispatch, 'hub' unless a tap's, full when
//   the tap found In Progress full) and its builder. → the start ({key, kind, model, worktree, bumped?}) or null when refused.
// - grill or prototype: the planner from its brief, or io.kept (a Block's stopped briefs entry).
// - visual or reviewer: the agent beside the card's other runs.
// - helper: the helper io.name.
// → {held, started?}
export async function start(site, key, kind, io) {
  io = ioOf(io);
  const pass = { held: false };
  if (kind === 'build') {
    const started = await store.startTappedBuild(site, key, (opts) => boardWorktree(site, key.split('/')[1], opts), io.dispatch ?? 'hub', io.full === undefined ? {} : { full: io.full });
    await handOff(site, started, io);
    return { held: pass.held, started };
  }
  io.stale();
  if (kind === 'helper') await launchHelper(site, key, io.name, io);
  else if (beside({ kind })) await launchBeside(site, key, kind, io);
  else await launchPlanner(site, key, kind, io.kept ?? null, io, pass);
  return pass;
}

// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md
// An unblocked card (the owner's Unblock, or its pick-up time) gets back the run its block stopped, with no session: a grill
// or prototype launches again, and a build starts afresh as the pull starts one. A card whose block stopped nothing is
// the pull's. A lander or rebase run is left to tick. A start the board refuses is its thread line, and a card left with
// nothing running is the orchestrator's wait (domain.mjs orchestratorWaitOf). → {held}
export async function resume(site, key, io) {
  io = ioOf(io);
  const run = await store.takeHoldStopped(site, key);
  if (!run) return { held: false };
  io.log({ call: 'resume', key, result: run.kind, reason: 'Its hold stopped this run.', inputs: run });
  if (run.kind === 'grill' || run.kind === 'prototype') return start(site, key, run.kind, { ...io, kept: run.brief });
  if (run.label === 'Builder') return start(site, key, 'build', io);
  return { held: false };
}

// ---- Stopping and finishing a run ----

const ARGS_CAP = 120;
export const pidLines = (stopped) => stopped.map((p) => `stopped ${p.pid} ${p.args.length > ARGS_CAP ? `${p.args.slice(0, ARGS_CAP - 1)}…` : p.args}`);
export const stoppedLines = (ref, run, stopped) => [`${ref}: ${stoppedWords(run)}`, ...pidLines(stopped)];
export const startsBy = ({ ps }) => (pids) => processStarts(pids, { ps });

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// Marks the card's run (build or land) stopped, so nothing relaunches it, stops the process leading leader with every
// process under it (headless.mjs stopRuns), and writes the stop's words as a thread line. → the processes it stopped
export async function stopProcess(site, key, run, leader, runner) {
  await store.markStopped(site, key, run);
  const processes = await stopRuns([leader], runner);
  await store.appendStatus(site, key, 'run-stopped', { words: stoppedWords(run) });
  return processes;
}

// The card's board-launched runs that aren't planners, whose processes launchBuilder started.
export const launchedBuilds = async (site, key, runner = {}) => launchedAgents((await store.openRuns(site, key)).filter((r) => !plans(r)), { starts: startsBy(runner) });

// The card's running build the board launched: {pid, at} of its agent, refusing a planner, a session's own builder or none.
async function launchedBuild(site, key, ref, runner) {
  const runs = await store.openRuns(site, key);
  const builds = runs.filter((r) => !plans(r));
  if (!builds.length && runs.length) fail(`${ref} has a ${runs[0].kind} planner running, not a build; builder stop stops builds, landers and rebase runs`);
  if (builds.length && builds.every((r) => !r.pid)) fail(`${ref}'s builder wasn't launched by the board, so it isn't the board's to stop; stop it in its own session`);
  return launchedAgents(builds, { starts: startsBy(runner) })[0] ?? fail(`${ref}'s builder isn't running`);
}

// Stops a run on the card.
// - kill: the orchestrator's `builder stop`: the card's board-launched builder, lander or rebase run stops with every
//   process under it, marked so nothing relaunches it, with the stop's words as a thread line. flags {ps, grace} are
//   headless.mjs stopRuns' runner. → {lines}
// - otherwise: closes the agent's record (store.mjs closeRecord: flags {dir, agent, startedBetween, note, next,
//   requireNext}), for the SubagentStop hook and a closed board. → the record's file
export async function stop(site, key, { kill = false, ...flags } = {}) {
  if (!kill) return store.closeRecord(site, key, flags);
  const ref = await store.cardName(site, key);
  const agent = await launchedBuild(site, key, ref, flags);
  const run = await store.isLanding(site, key) ? 'land' : 'build';
  const processes = await stopProcess(site, key, run, agent.pid, flags);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return { lines: stoppedLines(ref, run, processes) };
}

// A closed board's open records each stop, with a note that its work is kept. → the records it stopped
// (store.mjs openBoardBuilders)
export async function closeBoardBuilders(site) {
  const builders = await store.openBoardBuilders(site);
  for (const builder of builders) await stop(site, builder.key, { agent: builder.agent, note: 'Board closed. Builder record stopped; work is kept for reopening.' });
  return builders;
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// `builder done` for a record that doesn't finish the card: a helper's closes with its result, text, as its closing
// note, which agent wait prints; a planner's closes as store.mjs stopPlanner does (a fault line when it asked nothing);
// a builder's closes requiring a Next when it is the card's last open record. A done with --text where it takes none, or
// a helper's without it, throws usage (the CLI's usage error). → the close's {file, lines?}
export async function finish(site, key, { text, ...flags }, { usage = store.BoardError } = {}) {
  const onBoard = site && !flags.dir;
  if (onBoard && await store.isHelper(site, key, flags.agent)) {
    if (text === undefined) throw new usage('a helper hands back its result: pass --text "<what you did or found>"');
    return store.closeRecord(site, key, { ...flags, note: text });
  }
  if (onBoard && await store.isPlanner(site, key, flags.agent)) {
    if (text !== undefined) throw new usage('a grill\'s or prototype\'s done takes no --text: what it asked is its posted questions and its notes section');
    return store.stopPlanner(site, key, { ...flags, requireNext: true });
  }
  if (text !== undefined) throw new usage('--text goes on a builder done that finishes the task, the main build with a worktree and no --next, or on a helper\'s');
  return store.closeRecord(site, key, { ...flags, requireNext: true });
}

// `board.mjs lander <card>`, the orchestrator's restart of a card's land: hands back a lander's open record
// (store.mjs relaunchLander) and drops the card's landers.json entry, so the next tick launches the land as a
// verification's first, with its relaunch to spend again. Refuses a card with neither.
export async function restartLander(site, key) {
  const open = await store.hasOpenRecord(site, key);
  const file = fileOf(site, LANDERS);
  if (!open && !Object.hasOwn(await readJSON(file, {}), key)) fail(`${key} has no open builder and no lander; only a task whose lander stopped or exited has a land to restart`);
  if (open) await store.relaunchLander(site, key);
  await editJSON(file, (sent) => { delete sent[key]; });
}

// ---- The launch passes ----

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
// The due runs [{key}] with the bumped cards' first, the earliest bump first, the rest in their order.
const bumpOf = (items, key) => items.find((i) => i.key === key)?.bumpedAt || '';
const byBump = (items, due) => [...due.filter((d) => bumpOf(items, d.key)).sort((a, b) => bumpOf(items, a.key).localeCompare(bumpOf(items, b.key))), ...due.filter((d) => !bumpOf(items, d.key))];

// The cards whose run the orchestrator stopped (domain.mjs builderOf), which nothing relaunches.
const stoppedKeys = (items) => new Set(items.filter((c) => c.builder?.stopped).map((c) => c.key));

// docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md
// Each open planner record whose process is gone closes now (store.mjs closeGonePlanners): one the usage limit stopped
// queues to relaunch after the reset. Run before the board is read, so the line lands now and the card's next brief
// launches in this pass. → whether any closed
export async function closeGone(site, io) {
  io = ioOf(io);
  const logs = path.join(io.home, '.claude', 'kickflip', 'logs');
  const gone = await store.closeGonePlanners(site, {
    alive: (record) => agentMayRun({ pid: record.session.pid, at: record.session.at }),
    failure: (record) => runFailure(path.join(logs, record.session.log ?? '')),
    limited: (record) => (record.session.log ? runLimit(path.join(logs, record.session.log)) : null),
  });
  for (const c of gone) {
    if (c.limited) await queuePlanner(site, c.key, c.kind, { kept: c.limited.brief, until: c.limited.until });
    io.log({ call: 'planner-gone', key: c.key, result: c.limited ? 'queued' : c.failed ? 'failed' : 'closed', reason: c.limited ? `Its ${c.kind} run stopped at the usage limit, which resets at ${c.limited.until}; it relaunches then.` : `Its ${c.kind} planner's process was gone with its record open.`, inputs: c });
  }
  if (gone.length) io.stale();
  return gone.length > 0;
}

// The planners launchPlanner queued during a hold, oldest asked first, each once, until a launch is held again.
async function launchQueuedPlanners(site, io, pass) {
  for (const [queuedKey, { kind, kept, until }] of Object.entries(await queuedPlanners(site))) {
    const key = queuedPlannerCard(queuedKey);
    if (heldNow(site, pass)) return;
    if (until && Date.parse(until) > Date.now()) continue;
    await editJSON(fileOf(site, QUEUED), (queued) => { delete queued[queuedKey]; });
    io.log({ call: 'planner-queued', key, result: 'launching', reason: 'The hold it waited on has lifted.', inputs: { kind } });
    if (beside({ kind })) await store.restoreBrief(site, key, kept);
    else await launchPlanner(site, key, kind, kept, io, pass);
    io.stale();
  }
}

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
// Each agent due from a written brief (domain.mjs briefsDue) launches: a grill or prototype planner, or a visual agent
// or reviewer beside whatever else runs on the card, so an agent's finish, which changes its record, brings in the
// card's next brief. Passes on a site run one at a time, and the starts read the card again, so a brief opens one record
// however stale items is.
const briefsPasses = new Map();
function launchBriefs(site, items, io, pass) {
  const next = (briefsPasses.get(site) ?? Promise.resolve()).then(() => launchBriefed(site, items, io, pass));
  briefsPasses.set(site, next.catch(() => {}));
  return next;
}
async function launchBriefed(site, items, io, pass) {
  for (const { key, kind } of briefsDue(items)) {
    if (heldNow(site, pass)) return;
    io.stale();
    if (beside({ kind })) await launchBeside(site, key, kind, io);
    else await launchPlanner(site, key, kind, null, io, pass);
  }
}

// docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
// The lander launched for each card's verification (landers.json). Each card whose verified build waits to land
// (store.mjs landable) takes the one step domain.mjs landStep gives it: running and a skip (domain.mjs landSkipOf:
// worktree-gone, blocked, asking) leave it, held waits for the hold to clear, launch lands it through its builder
// (headless.mjs landByBuilder: the first launch resumes the builder, a relaunch is a fresh lander), and fault, the first
// time, puts the exited-twice line on the card and marks the entry handedBack, so the orchestrator's wait on it is a
// stale one. A lander whose process has gone while its own record is still open stopped partway: its card is handed
// back again (store.mjs relaunchLander) and takes its step in this pass. A lander the orchestrator stopped (stopped) is
// neither sent back nor relaunched. A dead lander whose card has no lander open and isn't handed back (landed, archived,
// or built again) has its entry dropped; relaunchLander would restore an archived card from the archive. A lander is
// only ever due on a handed-back card, so with none handed back and none sent back, landable's read of the wave files is
// skipped. Bumped cards' landers go first; each runs on its card's own slot
// (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
async function launchLanders(site, items, stopped, io, pass) {
  const anyChecking = items.some((i) => i.waitsOn === 'checking');
  const status = Object.fromEntries(items.map((i) => [i.key, i.waitsOn === 'checking' ? 'checking'
    : i.lane !== 'done' && i.agents?.some((a) => a.started && !a.done && a.label === LANDER) ? 'landing' : null]));
  const file = fileOf(site, LANDERS);
  const sent = await readLanders(site);
  // A run seen ending on the usage limit keeps that mark, since the limit's reset clears what runLimit reads.
  const kept = Object.fromEntries(Object.entries(sent).map(([key, { alive: _, limited, ...entry }]) => [key, { ...entry, ...(limited ? { limited } : {}) }]));
  const stored = await readJSON(file, {});
  const was = JSON.stringify(stored);
  // The cards' land steps read it. Merged with what restartLander wrote meanwhile.
  const save = async () => { if (JSON.stringify(kept) !== was) await writeJSON(file, kept, { from: stored }); };
  let sentBack = false;
  for (const [key, entry] of Object.entries(sent)) {
    if (!entry.pid || entry.alive || stopped.has(key) || status[key] === 'checking') continue;
    if (status[key] !== 'landing') { delete kept[key]; continue; }
    await store.relaunchLander(site, key);
    sentBack = true;
    io.log({ call: 'lander', key, result: 'handed back again', reason: 'Its lander exited with its record still open.', inputs: kept[key] });
  }
  if (!anyChecking && !sentBack) return save();
  const gate = readUsageGate({ dir: site });
  const cards = new Map(items.map((i) => [i.key, i]));
  const due = (await store.landable(site)).filter((c) => cards.has(c.key) && !cards.get(c.key).finished);
  for (const c of byBump(items, due)) {
    const step = landStep({ verified: c.verified, entry: sent[c.key], alive: sent[c.key]?.alive, limited: sent[c.key]?.limited, skip: landSkipOf(cards.get(c.key), c.skip), held: launchHeldWords(gate, c.kind ?? 'claude') });
    const inputs = { verified: c.verified, before: kept[c.key] ?? null };
    if (step.step === 'held') pass.held = true;
    if (step.step === 'fault' && !kept[c.key].handedBack) {
      io.log({ call: 'lander', key: c.key, result: 'handed back', reason: 'Its lander was relaunched and exited again without landing.', inputs });
      await store.appendStatus(site, c.key, 'exited-twice', { run: 'lander' });
      kept[c.key] = { ...kept[c.key], handedBack: true };
    }
    if (step.step !== 'launch') continue;
    const entry = { call: 'lander', key: c.key, reason: step.relaunched ? 'Its lander exited without landing, the first time.' : 'Its build was verified and waits to land.', inputs };
    try {
      const { pid, log, resumed } = await landByBuilder(site, c, { fresh: step.fresh, launch: io.launch });
      kept[c.key] = { verified: c.verified, pid, log, relaunched: step.relaunched };
      io.log({ ...entry, result: resumed ? 'resumed its builder' : 'launched' });
      await trackLaunch(site, c.key, null);
    } catch (e) {
      io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
      kept[c.key] = { verified: c.verified, pid: null, relaunched: step.relaunched };
      await store.appendStatus(site, c.key, 'lander-failed', { error: e.message });
    }
  }
  await save();
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The conflict (the PR's head @ the base) each rebase run was started for (rebases.json), so each conflict gets one
// run, and its process. Each card whose open PR conflicts (domain.mjs rebasesDue) gets a headless rebase run in its
// worktree, or one made from the PR's branch (store.mjs startRebase). A start or launch that fails leaves a thread line
// and keeps its conflict, so it isn't retried until the PR's head or base moves. A run takes no implementer slot
// (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
// docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md: a run whose process has gone with its
// record still open takes landStep's step for its conflict, as a lander does for its verification: relaunched once as
// a fresh run when no hold stands, then, exiting again, the exited-twice line and handedBack, so its card reads stopped
// (alive). A run the orchestrator stopped (stopped) is neither.
async function launchRebases(site, items, stopped, io, pass) {
  const file = fileOf(site, REBASES);
  const sent = await readJSON(file, {});
  const was = JSON.stringify(sent);
  const { base } = builderRepo(site);
  const gate = readUsageGate({ dir: site });
  for (const [key, run] of Object.entries(sent)) {
    if (!Number.isInteger(run.pid) || run.handedBack || stopped.has(key) || pidAlive(run.pid)) continue;
    const open = items.find((i) => i.key === key)?.agents?.find((a) => a.started && !a.done && a.label === store.REBASE_LABEL);
    if (!open) continue;
    const limited = Boolean(run.limited) || (Boolean(run.log) && Boolean(runLimit(run.log)));
    // landStep reads a run's conflict where it reads a lander's verification.
    const step = landStep({ verified: run.conflict, entry: { ...run, verified: run.conflict }, limited, held: launchHeldWords(gate, open.kind ?? 'claude') });
    const inputs = { conflict: run.conflict, before: run };
    if (step.step === 'fault') {
      io.log({ call: 'rebase-run', key, result: 'handed back', reason: 'Its rebase run was relaunched and exited again with its record open.', inputs });
      await store.appendStatus(site, key, 'exited-twice', { run: 'rebase run' });
      sent[key] = { ...run, handedBack: true };
    } else if (step.step === 'held') {
      pass.held = true;
      if (limited) sent[key] = { ...run, limited };
    } else {
      try {
        const { pid, log } = await landByBuilder(site, { key, kind: open.kind ?? 'claude', model: open.model }, { fresh: step.fresh, launch: io.launch });
        sent[key] = { conflict: run.conflict, pid, log, relaunched: step.relaunched };
        io.log({ call: 'rebase-run', key, result: 'relaunched', reason: 'Its rebase run exited with its record open, the first time.', inputs });
      } catch (e) {
        io.log({ call: 'rebase-run', key, result: 'failed', reason: `Its rebase run exited with its record open. The launch failed: ${e.message}`, inputs });
        await store.appendStatus(site, key, 'rebase-launch-failed', { error: e.message });
        sent[key] = { conflict: run.conflict, pid: null, relaunched: step.relaunched };
      }
    }
  }
  const due = byBump(items, rebasesDue(items, Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.conflict])), base));
  if (!due.length) {
    // A card's alive reads it.
    if (JSON.stringify(sent) !== was) await writeJSON(file, sent);
    return;
  }
  try {
    for (const d of due) {
      if (heldNow(site, pass)) break;
      const id = d.key.split('/')[1];
      const entry = { call: 'rebase-run', key: d.key, reason: `Its PR #${d.pr} conflicts with ${base}.`, inputs: { pr: d.pr, conflict: d.conflict, before: sent[d.key] ?? null } };
      sent[d.key] = { conflict: d.conflict, pid: null };
      let started;
      try {
        started = await store.startRebase(site, d.key, { pr: d.pr, conflict: d.conflict, base }, () => prWorktree(site, id, d.branch));
      } catch (e) {
        if (!(e instanceof store.BoardError)) throw e;
        io.log({ ...entry, result: 'refused', reason: `${entry.reason} The start refused: ${e.message}` });
        await store.appendStatus(site, d.key, 'rebase-failed', { pr: d.pr, error: e.message });
        continue;
      } finally { io.stale(); }
      try {
        const { pid, log } = await landByBuilder(site, started, { launch: io.launch });
        sent[d.key] = { ...sent[d.key], pid, log };
        io.log({ ...entry, result: 'launched' });
      } catch (e) {
        io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
        await store.appendStatus(site, d.key, 'rebase-launch-failed', { error: e.message });
      }
    }
  } finally {
    // Written even when a start throws, so a run already launched in this pass isn't started again.
    await writeJSON(file, sent);
  }
}

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// A paused build nothing pauses any more resumes: its pause comes off with a "Resumed: …" line (store.mjs
// resumePaused), and a build the board launched resumes in its own session (headless.mjs resumeBuilder), tracked as a
// fresh launch. A session's own builder is the orchestrator's to resume: builder-resume wakes it.
async function resumeBuild(site, key, io) {
  // A builder whose hard stop got no answer from ps may still run: the pause stays until its process is gone.
  if (hasBuilder((await store.openRuns(site, key)).filter((r) => r.pid))) return;
  const resumed = await store.resumePaused(site, key);
  if (!resumed) return;
  const { pause, record } = resumed;
  const cleared = PAUSE_CLEARS[pause.cause][1];
  io.stale();
  const entry = { call: 'resume', key, reason: `Nothing pauses it any more: ${cleared}.`, inputs: { pause } };
  if (!record.session?.pid) {
    io.log({ ...entry, result: 'woke the orchestrator' });
    return io.event('builder-resume', { key, cleared });
  }
  const kind = providerOf(record.kind) ?? 'claude';
  try {
    const why = `The board paused this build, and the pause has cleared: ${cleared}.`;
    const { pid, log, resumed: same } = await resumeBuilder(site, { key, kind, model: record.model, session: { id: record.session.id, log: record.session.log }, brief: (facts) => resumeBrief({ ...facts, cleared }), why, launch: io.launch });
    await trackLaunch(site, key, { kind, model: record.model, pid, log, relaunched: false });
    io.log({ ...entry, result: same ? 'resumed' : 'fresh builder' });
  } catch (e) {
    io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
    await store.appendStatus(site, key, 'resume-failed', { error: e.message });
  }
}

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
// A handed-back build the orchestrator's builder resume marked rerun opens again (store.mjs takeRerun) and its
// builder's own session resumes with the news since its hand-back (headless.mjs resumeBuilder), tracked as a fresh
// launch, as a cleared pause's resume is.
async function rerunBuild(site, key, io) {
  const taken = await store.takeRerun(site, key);
  if (!taken) return;
  const { record, news } = taken;
  io.stale();
  const entry = { call: 'rerun', key, reason: "The orchestrator's builder resume on its handed-back build.", inputs: { news } };
  try {
    const { pid, log, resumed } = await resumeBuilder(site, { key, kind: 'claude', model: record.model, session: { id: record.session.id, log: record.session.log }, brief: (facts) => rerunBrief({ ...facts, news }), why: news.join(' '), launch: io.launch });
    await trackLaunch(site, key, { kind: 'claude', model: record.model, pid, log, relaunched: false });
    io.log({ ...entry, result: resumed ? 'resumed' : 'fresh builder' });
  } catch (e) {
    io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
    await store.appendStatus(site, key, 'resume-failed', { error: e.message });
  }
}

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
// The board's launch passes on built, the built board's items, as one call on each Auto check, while no hold stands:
// the planners a hold queued, the agents due from briefs, the landers, the rebase runs, then due's resumes (the paused
// builds domain.mjs pauseWork lets resume), the reruns the orchestrator asked for, and due's helpers (domain.mjs
// pullOf's). A launch found held marks the pass held, and the passes after it wait for the next tick. → {held}
export async function tick(site, built, io, { resumes = [], helpers = [] } = {}) {
  io = ioOf(io);
  const pass = { held: false };
  const stopped = stoppedKeys(built);
  const reruns = built.filter((i) => i.kind === 'work' && i.lane === 'progress' && i.agents?.some((a) => a.name === 'main' && a.rerun));
  const passes = [
    () => launchQueuedPlanners(site, io, pass),
    () => launchBriefs(site, built, io, pass),
    () => launchLanders(site, built, stopped, io, pass),
    () => launchRebases(site, built, stopped, io, pass),
    async () => { for (const key of resumes) await resumeBuild(site, key, io); },
    async () => { for (const it of reruns) await rerunBuild(site, it.key, io); },
    async () => {
      for (const { key, name } of helpers) {
        if (heldNow(site, pass)) return;
        io.stale();
        await launchHelper(site, key, name, io);
      }
    },
  ];
  for (const run of passes) {
    if (pass.held || heldNow(site, pass)) break;
    await run();
  }
  return pass;
}

// Whether a pull may start the card: no open build record that may still run, and no tracked builder whose process lives.
export async function unstarted(site, key) {
  const tracked = (await readJSON(fileOf(site, TRACKED), {}))[key];
  return !hasBuilder(await store.openRuns(site, key)) && !(tracked?.pid && pidAlive(tracked.pid));
}

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
// tracked is {<key>: {kind, model, pid, log, relaunched}}, the headless builds launched or meant to launch (pid null:
// held by the usage pause or not yet launched). open is the set of keys whose builder record is still open. A tracked
// build whose record has closed drops. One with no pid yet launches; one whose process has exited with its record still
// open launches again once, and the second time goes to handBack, once: it stays tracked, marked handedBack, so its
// card reads stopped (alive). One whose kind held(kind) says its usage holds waits as it is
// (docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md). One the orchestrator stopped (stopped, the keys
// whose card reads it) is handed back at once, with no line, since the stop wrote its own. One paused (paused, the keys
// whose build reads paused) waits as it is, since the board resumes it
// (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md). One whose process exited on
// the usage limit (limitedUntil(entry), its reset, else null) doesn't spend its relaunch: atLimit(card, until) pauses it,
// pid null. launch({key, kind, model}) → {pid, log}.
// → the tracked map as it now stands.
export async function reviveBuilders(tracked, open, { launch, handBack, alive: lives = pidAlive, held = () => false, stopped = new Set(), paused = new Set(), limitedUntil = () => null, atLimit = async () => {} }) {
  const next = {};
  for (const [key, entry] of Object.entries(tracked)) {
    if (!open.has(key)) continue;
    if (stopped.has(key)) { next[key] = { ...entry, handedBack: true }; continue; }
    if (paused.has(key) || (entry.pid !== null && lives(entry.pid)) || entry.handedBack) { next[key] = entry; continue; }
    const card = { key, ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.model ? { model: entry.model } : {}) };
    const until = entry.pid !== null ? limitedUntil(entry) : null;
    if (until) { await atLimit(card, until); next[key] = { ...entry, pid: null }; continue; }
    if (held(entry.kind ?? 'claude')) { next[key] = entry; continue; }
    if (entry.pid !== null && entry.relaunched) { await handBack(card); next[key] = { ...entry, handedBack: true }; continue; }
    const { key: _, ...kept } = card;
    next[key] = { ...kept, ...(await launch(card)), relaunched: entry.pid !== null || Boolean(entry.relaunched) };
  }
  return next;
}

// Once a minute: a headless builder whose usage isn't held and whose process exited with its record open launches again
// once, and after that leaves a thread line; its record stays open, so its stale wait brings in the orchestrator. One
// whose run log ends on the usage limit (hub/usage.mjs runLimit) keeps its relaunch: it reads paused, and the pause pass
// resumes it once the limit resets (docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md). A
// paused build is never relaunched. One pass per site at a time.
const reviving = new Set();
async function reviveHeadless(site, built, io) {
  if (reviving.has(site)) return;
  reviving.add(site);
  try {
    const file = fileOf(site, TRACKED);
    const tracked = await readJSON(file, {});
    if (!Object.keys(tracked).length) return;
    const items = await built();
    const open = new Set(items.filter((c) => c.lane !== 'done' && c.builder && !c.builder.planner).map((c) => c.key));
    const handBack = async (card) => {
      io.log({ call: 'relaunch', key: card.key, result: 'handed back', reason: 'Its builder exited twice with its record open.', inputs: tracked[card.key] });
      await store.appendStatus(site, card.key, 'exited-twice');
    };
    const relaunch = async (card) => {
      const was = tracked[card.key];
      const entry = { call: 'relaunch', key: card.key, inputs: was,
        reason: was.pid === null ? 'Its launch was held by a pause or a busy host, which has lifted.' : 'Its builder exited with its record open, for the first time.' };
      try {
        const { pid, log } = await launchBuilder(site, card, { launch: io.launch });
        io.log({ ...entry, result: was.pid === null ? 'launched' : 'relaunched' });
        return { pid, log };
      } catch (e) {
        io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
        await store.appendStatus(site, card.key, 'relaunch-failed', { error: e.message });
        return { pid: null };
      }
    };
    // The run the limit stopped is the same pause, resumed in its own session once the limit resets.
    const atLimit = async (card, until) => {
      io.log({ call: 'relaunch', key: card.key, result: 'paused', reason: `Its run stopped at the usage limit, which resets at ${until}.`, inputs: tracked[card.key] });
      await store.requestPause(site, card.key, { cause: 'usage', words: 'usage limit', until });
      await store.markPaused(site, card.key);
      io.stale();
    };
    const paused = new Set(items.filter((c) => c.builder?.pause?.paused).map((c) => c.key));
    const next = await reviveBuilders(tracked, open, { launch: relaunch, handBack, held: (kind) => heldFor(readUsageGate({ dir: site }), kind), stopped: stoppedKeys(items), paused,
      limitedUntil: (entry) => (entry.log ? runLimit(entry.log) : null), atLimit });
    if (JSON.stringify(next) !== JSON.stringify(tracked)) await writeJSON(file, next, { from: tracked });
  } finally {
    reviving.delete(site);
  }
}

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
// At boot: a build the previous process started but died before launching (store.mjs cutOffBuilds) that
// headless-builders.json doesn't list gets its builder now, as the pull would have launched it.
async function launchCutOffBuilds(site, io) {
  const tracked = await readJSON(fileOf(site, TRACKED), {});
  for (const started of (await store.cutOffBuilds(site)).filter((c) => !tracked[c.key])) {
    io.log({ call: 'launch-cut-off', key: started.key, result: 'launching', reason: 'A restart cut off the launch after its build started.', inputs: { kind: started.kind, model: started.model ?? null } });
    await handOff(site, started, io);
  }
}

// docs/adr/2026-11-15-1630-a-pulled-card-whose-launch-was-lost-launches-again.md
// A card In Progress that has no agent record (store.mjs lostLaunches) had its pull cut off after the card moved and
// before its build started: it starts as the pull would have, at boot and each minute. A card moved within the last
// LOST_GRACE_MS may be a start still under way, so only boot, which has none, takes it at once.
const LOST_GRACE_MS = 120000;
async function launchLostBuilds(site, built, io, grace) {
  if (heldFor(readUsageGate({ dir: site }), 'claude')) return;
  const blocked = new Set((await built()).filter((c) => c.blockedBy?.length).map((c) => c.key));
  for (const key of (await store.lostLaunches(site, new Date(Date.now() - grace).toISOString())).filter((k) => !blocked.has(k))) {
    const { started } = await start(site, key, 'build', io);
    io.log({ call: 'launch-lost', key, result: startResult(started), reason: 'It was In Progress with no agent record: its pull was cut off before its build started.', inputs: {} });
  }
}

// The minute's relaunches: a dead or held headless builder (reviveHeadless), then a lost launch (launchLostBuilds). At
// boot, a build cut off before its launch instead of the first, and a lost launch is taken with no grace. read() → the
// built board's items, read once, and only when a step needs them. Each step's failure is logged and leaves the next to run.
export async function revive(site, read, io, { boot = false } = {}) {
  io = ioOf(io);
  let items = null;
  const built = async () => (items ??= await read());
  if (boot) await launchCutOffBuilds(site, io).catch((e) => console.error('Cut-off launch check failed:', e.message));
  else await reviveHeadless(site, built, io).catch((e) => console.error('Headless builder check failed:', e.message));
  await launchLostBuilds(site, built, io, boot ? 0 : LOST_GRACE_MS).catch((e) => console.error('Lost launch check failed:', e.message));
}
