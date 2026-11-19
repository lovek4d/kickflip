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
// - launches/<key>~<agent>: the exclusive claim each launch takes before it spawns, holding the agent's pid, so two
//   servers launch a run once (docs/adr/2026-11-18-2030-a-launch-is-one-exclusive-claim.md).
// A run's record, agents/<id>.json on its card (a builder, planner, visual agent, reviewer, helper, lander or rebase
// run), is in this module too, below the launch passes: opening it at a start, the builder's commands on it (progress,
// calls, asks, summary, done) and closing it, with the card and question writes those make through cards.mjs and
// questions.mjs (docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md).
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLine, editJSON, itemSources, readJSON, readLog, remove, writeJSON } from './files.mjs';
import { agentMayRun, hasBuilder, landByBuilder, launchBuilder, launchedAgents, pidAlive, releaseLaunch, rerunBrief, resumeBrief, resumeBuilder, runFailure, stopRuns } from './headless.mjs';
import { beside, besideAgent, BUILD_REFUSED, BUILDER_ASK, briefsDue, builds, bumpIn, byBump, handedBackAt, HELPER, LANDER, landSkipOf, landStep, LANES, LOGGED_OUT_WORDS, modelName, MOVE, owesNext, PAUSE_CLEARS, PHASES, PLANNER_WORD, plans, providerOf, queuedPlannerCard, queuedPlannerKey, rebasesDue, REVIEWER, stoppedWords, SUMMARY_HINT, VISUAL } from './domain.mjs';
import { boardWorktree, builderRepo, clearStoppedLand, helperWorktree, prWorktree } from './worktree.mjs';
import { builderPick, heldFor, holdsWork, launchHeldWords, pauseReason, pauseReasonFor, readUsageGate } from '../shared/usage-gate.mjs';
import { readClaudeModel } from '../shared/hub-settings.mjs';
import { runLimit } from '../hub/usage.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { processStarts } from '../hub/live.mjs';
import { appendEvent } from '../hub/boards.mjs';
import { audit, auditLines, boardAudit, readAudit } from '../shared/audit.mjs';
import { cardPRs, storedPRs } from '../shared/card-prs.mjs';
import { startTitleBrief, startTitleFault } from './commit-message.mjs';
import { BRIEF_LINE_LIMIT, lineFault } from './hub-lines.mjs';
import { BoardError, fail, needSite, optional, pageUrl, text } from './checks.mjs';
import { appendStatus, blockerNames, cardName, checkNextDeps, depCards, depKey, leftTodo, loadItem, openKeys, ownerFile, parseKey, placeIn, recordOwnerTap, setItem, shownCard, threadFile } from './cards.mjs';
import { asksImplement, briefOn, cardQuestions, clearNext, dropBrief, hasOpenQuestion, markWaiting, moveOnAnswered, noBrief, publishStaged, resolveAnswered, restoreBrief, setNext, stagedFile, stageImplement, unpickedPrototype } from './questions.mjs';
import { askItem } from './asks.mjs';
import { markdownPage } from './markdown-page.mjs';
import { boardRepoOf, boardTarget } from './settings.mjs';

const fileOf = (site, name) => path.join(site, 'data', name);
const TRACKED = 'headless-builders.json';
const LANDERS = 'landers.json';
const REBASES = 'rebases.json';
const QUEUED = 'queued-planners.json';

const quiet = { log: () => {}, stale: () => {}, event: async () => {} };
const ioOf = (io) => ({ ...quiet, home: os.homedir(), ...io });

// The board's launches of kind, a bumped card's when bumped, are held now (shared/usage-gate.mjs heldFor), marked on
// the pass.
function heldNow(site, pass, kind = 'claude', bumped = false) {
  const held = heldFor(readUsageGate({ dir: site }), kind, bumped);
  if (held) pass.held = true;
  return held;
}
// Whether gate holds a launch of kind on the card key, reading its standing bump (landFirst) only when a hold stands.
const heldOn = async (gate, site, key, kind) => heldFor(gate, kind) && heldFor(gate, kind, Boolean(await landFirst(site, key)));

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
// A build started ({key, kind, model, worktree}, startTappedBuild's) launches its builder, Claude or Codex. A
// launch that fails puts the card back in Todo with the reason (abandonLaunch). A pause on its kind or a busy
// host that began after the pull or the tap holds the launch, tracked with pid null; revive launches it once the hold
// lifts. A busy Mac says so on the card (docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md), and holds no bumped
// card's launch (heldOn).
async function handOff(site, started, io) {
  io.stale();
  if (!started || started.bumped) return;
  const entry = { kind: started.kind, model: started.model, relaunched: false };
  try {
    const gate = readUsageGate({ dir: site });
    if (await heldOn(gate, site, started.key, started.kind)) {
      io.log({ call: 'launch-held', key: started.key, result: 'held', reason: pauseReasonFor(gate, started.kind), inputs: { kind: started.kind, model: started.model ?? null, gate } });
      if (gate.machine.state === 'busy') await appendStatus(site, started.key, 'host-busy');
      await trackLaunch(site, started.key, { ...entry, pid: null });
    } else {
      const launched = await launchBuilder(site, started, { launch: io.launch });
      if (launched) await trackLaunch(site, started.key, { ...entry, pid: launched.pid, log: launched.log });
    }
  } catch (e) {
    await abandonLaunch(site, started.key, `the launch failed: ${e.message}`);
  }
}

// A planner, kind grill or prototype, opens on the card from its written brief, or from kept, the briefs entry of the
// run a Block stopped, and launches headless in the board's repo (startPlanner), unless an agent already works
// on it. One that can't start or launch leaves a thread line and its record closed. One due while the board's launches
// are held waits in queued-planners.json, with a thread line saying so, and launches when the hold lifts
// (launchQueuedPlanners); another of the same kind on the card replaces it. A busy host holds no bumped card's (heldOn).
// (docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md)
async function launchPlanner(site, key, kind, kept, io, pass) {
  const gate = readUsageGate({ dir: site });
  if (await heldOn(gate, site, key, 'claude')) {
    pass.held = true;
    await queuePlanner(site, key, kind, kept ? { kept } : {});
    io.log({ call: 'planner-queued', key, result: kind, reason: pauseReasonFor(gate, 'claude'), inputs: { kind, gate } });
    await appendStatus(site, key, gate.machine.state === 'busy' ? 'host-busy' : 'planner-held', { kind });
    return;
  }
  try {
    const started = await startPlanner(site, key, kind, kept);
    if (!started) return;
    try { await launchBuilder(site, started, { launch: io.launch }); } catch (e) {
      await abandonPlanner(site, key, ['planner-failed', { kind, error: e.message }]);
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await appendStatus(site, key, 'planner-failed', { kind, error: e.message });
  }
}

// A visual agent or reviewer, headless in the board's repo beside whatever else runs on the card
// (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md, startVisual). One that can't
// start or launch leaves a thread line and its record, if any, closed.
async function launchBeside(site, key, kind, io) {
  const named = kind === VISUAL ? 'visual agent' : kind;
  try {
    const started = await (kind === VISUAL ? startVisual : startReviewer)(site, key);
    if (!started) return;
    try { await launchBuilder(site, started, { launch: io.launch }); } catch (e) {
      await abandonPlanner(site, key, ['planner-failed', { kind: named, error: e.message }], started.agent);
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await appendStatus(site, key, 'planner-failed', { kind: named, error: e.message });
  }
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// A requested helper (name) opens its record (startHelper), one that writes in its own worktree off the card's
// branch, and launches headless. One that can't start or launch leaves a thread line and its record closed, which its
// spawner's agent wait reports.
async function launchHelper(site, key, name, io) {
  try {
    const started = await startHelper(site, key, name, (opts) => helperWorktree(key.split('/')[1], name, opts));
    if (!started) return;
    io.log({ call: 'helper', key, result: 'launching', reason: 'A helper was asked for and pullOf let it launch.', inputs: { name, model: started.model, worktree: started.worktree } });
    try { await launchBuilder(site, started, { launch: io.launch }); } catch (e) {
      await abandonPlanner(site, key, ['helper-failed', { name, error: e.message }], name);
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await abandonPlanner(site, key, ['helper-failed', { name, error: e.message }], name);
  }
}

// Starts a run of kind on the card and launches it:
// - build: the build's record (startTappedBuild, dispatched by io.dispatch, 'hub' unless a tap's, full when
//   the tap found In Progress full) and its builder. → the start ({key, kind, model, worktree, bumped?}) or null when refused.
// - grill or prototype: the planner from its brief, or io.kept (a Block's stopped briefs entry).
// - visual or reviewer: the agent beside the card's other runs.
// - helper: the helper io.name.
// → {held, started?}
export async function start(site, key, kind, io) {
  io = ioOf(io);
  const pass = { held: false };
  if (kind === 'build') {
    const started = await startTappedBuild(site, key, (opts) => boardWorktree(site, key.split('/')[1], opts), io.dispatch ?? 'hub', io.full === undefined ? {} : { full: io.full });
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
  const run = await takeHoldStopped(site, key);
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
  await markStopped(site, key, run);
  const processes = await stopRuns([leader], runner);
  await appendStatus(site, key, 'run-stopped', { words: stoppedWords(run) });
  return processes;
}

// The card's board-launched runs that aren't planners, whose processes launchBuilder started.
export const launchedBuilds = async (site, key, runner = {}) => launchedAgents((await openRuns(site, key)).filter((r) => !plans(r)), { starts: startsBy(runner) });

// The card's running build the board launched: {pid, at} of its agent, refusing a planner, a session's own builder or none.
async function launchedBuild(site, key, ref, runner) {
  const runs = await openRuns(site, key);
  const builds = runs.filter((r) => !plans(r));
  if (!builds.length && runs.length) fail(`${ref} has a ${runs[0].kind} planner running, not a build; builder stop stops builds, landers and rebase runs`);
  if (builds.length && builds.every((r) => !r.pid)) fail(`${ref}'s builder wasn't launched by the board, so it isn't the board's to stop; stop it in its own session`);
  return launchedAgents(builds, { starts: startsBy(runner) })[0] ?? fail(`${ref}'s builder isn't running`);
}

// Stops a run on the card.
// - kill: the orchestrator's `builder stop`: the card's board-launched builder, lander or rebase run stops with every
//   process under it, marked so nothing relaunches it, with the stop's words as a thread line. flags {ps, grace} are
//   headless.mjs stopRuns' runner. → {lines}
// - otherwise: closes the agent's record (closeRecord: flags {dir, agent, startedBetween, note, next,
//   requireNext}), for the SubagentStop hook and a closed board. → the record's file
export async function stop(site, key, { kill = false, ...flags } = {}) {
  if (!kill) return closeRecord(site, key, flags);
  const ref = await cardName(site, key);
  const agent = await launchedBuild(site, key, ref, flags);
  const run = await isLanding(site, key) ? 'land' : 'build';
  const processes = await stopProcess(site, key, run, agent.pid, flags);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return { lines: stoppedLines(ref, run, processes) };
}

// A closed board's open records each stop, with a note that its work is kept. → the records it stopped
// (openBoardBuilders)
export async function closeBoardBuilders(site) {
  const builders = await openBoardBuilders(site);
  for (const builder of builders) await stop(site, builder.key, { agent: builder.agent, note: 'Board closed. Builder record stopped; work is kept for reopening.' });
  return builders;
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// `builder done` for a record that doesn't finish the card: a helper's closes with its result, text, as its closing
// note, which agent wait prints; a planner's closes as stopPlanner does (a fault line when it asked nothing);
// a builder's closes requiring a Next when it is the card's last open record. A done with --text where it takes none, or
// a helper's without it, throws usage (the CLI's usage error). → the close's {file, lines?}
export async function finish(site, key, { text, ...flags }, { usage = BoardError } = {}) {
  const onBoard = site && !flags.dir;
  if (onBoard && await isHelper(site, key, flags.agent)) {
    if (text === undefined) throw new usage('a helper hands back its result: pass --text "<what you did or found>"');
    return closeRecord(site, key, { ...flags, note: text });
  }
  if (onBoard && await isPlanner(site, key, flags.agent)) {
    if (text !== undefined) throw new usage('a grill\'s or prototype\'s done takes no --text: what it asked is its posted questions and its notes section');
    return stopPlanner(site, key, { ...flags, requireNext: true });
  }
  if (text !== undefined) throw new usage('--text goes on a builder done that finishes the task, the main build with a worktree and no --next, or on a helper\'s');
  return closeRecord(site, key, { ...flags, requireNext: true });
}

// `board.mjs lander <card>`, the orchestrator's restart of a card's land: hands back a lander's open record
// (relaunchLander) and drops the card's landers.json entry, so the next tick launches the land as a
// verification's first, with its relaunch to spend again. Refuses a card with neither.
export async function restartLander(site, key) {
  const open = await hasOpenRecord(site, key);
  const file = fileOf(site, LANDERS);
  if (!open && !Object.hasOwn(await readJSON(file, {}), key)) fail(`${key} has no open builder and no lander; only a task whose lander stopped or exited has a land to restart`);
  if (open) await relaunchLander(site, key);
  await editJSON(file, (sent) => { delete sent[key]; });
}

// ---- The launch passes ----

// docs/adr/2026-11-19-0242-a-bump-goes-first-in-every-queue.md
// Every pass below walks its runs in the one bump order (domain.mjs byBump) and stops at the first a hold keeps, so a
// busy host, which holds no bumped card's launch, lets the bumped ones through and holds the rest.

// The cards whose run the orchestrator stopped (domain.mjs builderOf), which nothing relaunches.
const stoppedKeys = (items) => new Set(items.filter((c) => c.builder?.stopped).map((c) => c.key));

// docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md
// Each open planner record whose process is gone closes now (closeGonePlanners): one the usage limit stopped
// queues to relaunch after the reset. Run before the board is read, so the line lands now and the card's next brief
// launches in this pass. → whether any closed
export async function closeGone(site, io) {
  io = ioOf(io);
  const logs = path.join(io.home, '.claude', 'kickflip', 'logs');
  const gone = await closeGonePlanners(site, {
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

// The planners launchPlanner queued during a hold on built items, the bumped cards' first, then oldest asked first,
// each once, until a launch is held again.
async function launchQueuedPlanners(site, items, io, pass) {
  const bump = bumpIn(items);
  const queued = Object.entries(await queuedPlanners(site)).map(([queuedKey, entry]) => ({ queuedKey, key: queuedPlannerCard(queuedKey), ...entry }));
  for (const { queuedKey, key, kind, kept, until } of byBump(queued, (q) => bump(q.key))) {
    if (heldNow(site, pass, 'claude', Boolean(bump(key)))) return;
    if (until && Date.parse(until) > Date.now()) continue;
    await editJSON(fileOf(site, QUEUED), (queued) => { delete queued[queuedKey]; });
    io.log({ call: 'planner-queued', key, result: 'launching', reason: 'The hold it waited on has lifted.', inputs: { kind } });
    if (beside({ kind })) await restoreBrief(site, key, kept);
    else await launchPlanner(site, key, kind, kept, io, pass);
    io.stale();
  }
}

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
// Each agent due from a written brief (domain.mjs briefsDue), the bumped cards' first, launches: a grill or prototype
// planner, or a visual agent or reviewer beside whatever else runs on the card, so an agent's finish, which changes its record, brings in the
// card's next brief. Passes on a site run one at a time, and the starts read the card again, so a brief opens one record
// however stale items is.
const briefsPasses = new Map();
function launchBriefs(site, items, io, pass) {
  const next = (briefsPasses.get(site) ?? Promise.resolve()).then(() => launchBriefed(site, items, io, pass));
  briefsPasses.set(site, next.catch(() => {}));
  return next;
}
async function launchBriefed(site, items, io, pass) {
  const bump = bumpIn(items);
  for (const { key, kind } of byBump(briefsDue(items), (d) => bump(d.key))) {
    if (heldNow(site, pass, 'claude', Boolean(bump(key)))) return;
    io.stale();
    if (beside({ kind })) await launchBeside(site, key, kind, io);
    else await launchPlanner(site, key, kind, null, io, pass);
  }
}

// docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
// The lander launched for each card's verification (landers.json). Each card whose verified build waits to land
// (landable) takes the one step domain.mjs landStep gives it: running and a skip (domain.mjs landSkipOf:
// worktree-gone, blocked, asking) leave it, held waits for the hold to clear, launch lands it through its builder
// (headless.mjs landByBuilder: the first launch resumes the builder, a relaunch is a fresh lander), and fault, the first
// time, puts the exited-twice line on the card and marks the entry handedBack, so the orchestrator's wait on it is a
// stale one. A lander whose process has gone while its own record is still open stopped partway: its card is handed
// back again (relaunchLander) and takes its step in this pass. A lander the orchestrator stopped (stopped) is
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
    await relaunchLander(site, key);
    sentBack = true;
    io.log({ call: 'lander', key, result: 'handed back again', reason: 'Its lander exited with its record still open.', inputs: kept[key] });
  }
  if (!anyChecking && !sentBack) return save();
  const gate = readUsageGate({ dir: site });
  const cards = new Map(items.map((i) => [i.key, i]));
  const due = (await landable(site)).filter((c) => cards.has(c.key) && !cards.get(c.key).finished);
  const bump = bumpIn(items);
  for (const c of byBump(due, (d) => bump(d.key))) {
    const step = landStep({ verified: c.verified, entry: sent[c.key], alive: sent[c.key]?.alive, limited: sent[c.key]?.limited, skip: landSkipOf(cards.get(c.key), c.skip), held: launchHeldWords(gate, c.kind ?? 'claude', Boolean(bump(c.key))) });
    const inputs = { verified: c.verified, before: kept[c.key] ?? null };
    if (step.step === 'held') pass.held = true;
    if (step.step === 'fault' && !kept[c.key].handedBack) {
      io.log({ call: 'lander', key: c.key, result: 'handed back', reason: 'Its lander was relaunched and exited again without landing.', inputs });
      await appendStatus(site, c.key, 'exited-twice', { run: 'lander' });
      kept[c.key] = { ...kept[c.key], handedBack: true };
    }
    if (step.step !== 'launch') continue;
    const entry = { call: 'lander', key: c.key, reason: step.relaunched ? 'Its lander exited without landing, the first time.' : 'Its build was verified and waits to land.', inputs };
    try {
      const launched = await landByBuilder(site, c, { fresh: step.fresh, launch: io.launch });
      if (!launched) { io.log({ ...entry, result: 'claimed elsewhere' }); continue; }
      kept[c.key] = { verified: c.verified, pid: launched.pid, log: launched.log, relaunched: step.relaunched };
      io.log({ ...entry, result: launched.resumed ? 'resumed its builder' : 'launched' });
      await trackLaunch(site, c.key, null);
    } catch (e) {
      io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
      kept[c.key] = { verified: c.verified, pid: null, relaunched: step.relaunched };
      await appendStatus(site, c.key, 'lander-failed', { error: e.message });
    }
  }
  await save();
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The conflict (the PR's head @ the base) each rebase run was started for (rebases.json), so each conflict gets one
// run, and its process. Each card whose open PR conflicts (domain.mjs rebasesDue) gets a headless rebase run in its
// worktree, or one made from the PR's branch (startRebase). A start or launch that fails leaves a thread line
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
  const bump = bumpIn(items);
  const { base } = builderRepo(site);
  const gate = readUsageGate({ dir: site });
  for (const [key, run] of Object.entries(sent)) {
    if (!Number.isInteger(run.pid) || run.handedBack || stopped.has(key) || pidAlive(run.pid)) continue;
    const open = items.find((i) => i.key === key)?.agents?.find((a) => a.started && !a.done && a.label === REBASE_LABEL);
    if (!open) continue;
    const limited = Boolean(run.limited) || (Boolean(run.log) && Boolean(runLimit(run.log)));
    // landStep reads a run's conflict where it reads a lander's verification.
    const step = landStep({ verified: run.conflict, entry: { ...run, verified: run.conflict }, limited, held: launchHeldWords(gate, open.kind ?? 'claude', Boolean(bump(key))) });
    const inputs = { conflict: run.conflict, before: run };
    if (step.step === 'fault') {
      io.log({ call: 'rebase-run', key, result: 'handed back', reason: 'Its rebase run was relaunched and exited again with its record open.', inputs });
      await appendStatus(site, key, 'exited-twice', { run: 'rebase run' });
      sent[key] = { ...run, handedBack: true };
    } else if (step.step === 'held') {
      pass.held = true;
      if (limited) sent[key] = { ...run, limited };
    } else {
      try {
        const launched = await landByBuilder(site, { key, kind: open.kind ?? 'claude', model: open.model }, { fresh: step.fresh, launch: io.launch });
        if (!launched) { io.log({ call: 'rebase-run', key, result: 'claimed elsewhere', reason: 'Another process holds its launch claim.', inputs }); continue; }
        sent[key] = { conflict: run.conflict, pid: launched.pid, log: launched.log, relaunched: step.relaunched };
        io.log({ call: 'rebase-run', key, result: 'relaunched', reason: 'Its rebase run exited with its record open, the first time.', inputs });
      } catch (e) {
        io.log({ call: 'rebase-run', key, result: 'failed', reason: `Its rebase run exited with its record open. The launch failed: ${e.message}`, inputs });
        await appendStatus(site, key, 'rebase-launch-failed', { error: e.message });
        sent[key] = { conflict: run.conflict, pid: null, relaunched: step.relaunched };
      }
    }
  }
  const due = byBump(rebasesDue(items, Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.conflict])), base), (d) => bump(d.key));
  if (!due.length) {
    // A card's alive reads it.
    if (JSON.stringify(sent) !== was) await writeJSON(file, sent);
    return;
  }
  try {
    for (const d of due) {
      if (heldNow(site, pass, 'claude', Boolean(bump(d.key)))) break;
      const id = d.key.split('/')[1];
      const entry = { call: 'rebase-run', key: d.key, reason: `Its PR #${d.pr} conflicts with ${base}.`, inputs: { pr: d.pr, conflict: d.conflict, before: sent[d.key] ?? null } };
      sent[d.key] = { conflict: d.conflict, pid: null };
      let started;
      try {
        started = await startRebase(site, d.key, { pr: d.pr, conflict: d.conflict, base }, () => prWorktree(site, id, d.branch));
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        io.log({ ...entry, result: 'refused', reason: `${entry.reason} The start refused: ${e.message}` });
        await appendStatus(site, d.key, 'rebase-failed', { pr: d.pr, error: e.message });
        continue;
      } finally { io.stale(); }
      try {
        const launched = await landByBuilder(site, started, { launch: io.launch });
        if (launched) sent[d.key] = { ...sent[d.key], pid: launched.pid, log: launched.log };
        io.log({ ...entry, result: launched ? 'launched' : 'claimed elsewhere' });
      } catch (e) {
        io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
        await appendStatus(site, d.key, 'rebase-launch-failed', { error: e.message });
      }
    }
  } finally {
    // Written even when a start throws, so a run already launched in this pass isn't started again.
    await writeJSON(file, sent);
  }
}

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// A paused build nothing pauses any more resumes: its pause comes off with a "Resumed: …" line
// (resumePaused), and a build the board launched resumes in its own session (headless.mjs resumeBuilder), tracked as a
// fresh launch. A session's own builder is the orchestrator's to resume: builder-resume wakes it.
async function resumeBuild(site, key, io) {
  // A builder whose hard stop got no answer from ps may still run: the pause stays until its process is gone.
  if (hasBuilder((await openRuns(site, key)).filter((r) => r.pid))) return;
  const resumed = await resumePaused(site, key);
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
    const launched = await resumeBuilder(site, { key, kind, model: record.model, session: { id: record.session.id, log: record.session.log }, brief: (facts) => resumeBrief({ ...facts, cleared }), why, launch: io.launch });
    if (!launched) return io.log({ ...entry, result: 'claimed elsewhere' });
    await trackLaunch(site, key, { kind, model: record.model, pid: launched.pid, log: launched.log, relaunched: false });
    io.log({ ...entry, result: launched.resumed ? 'resumed' : 'fresh builder' });
  } catch (e) {
    io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
    await appendStatus(site, key, 'resume-failed', { error: e.message });
  }
}

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
// A handed-back build the orchestrator's builder resume marked rerun opens again (takeRerun) and its
// builder's own session resumes with the news since its hand-back (headless.mjs resumeBuilder), tracked as a fresh
// launch, as a cleared pause's resume is.
async function rerunBuild(site, key, io) {
  const taken = await takeRerun(site, key);
  if (!taken) return;
  const { record, news } = taken;
  io.stale();
  const entry = { call: 'rerun', key, reason: "The orchestrator's builder resume on its handed-back build.", inputs: { news } };
  try {
    const launched = await resumeBuilder(site, { key, kind: 'claude', model: record.model, session: { id: record.session.id, log: record.session.log }, brief: (facts) => rerunBrief({ ...facts, news }), why: news.join(' '), launch: io.launch });
    if (!launched) return io.log({ ...entry, result: 'claimed elsewhere' });
    await trackLaunch(site, key, { kind: 'claude', model: record.model, pid: launched.pid, log: launched.log, relaunched: false });
    io.log({ ...entry, result: launched.resumed ? 'resumed' : 'fresh builder' });
  } catch (e) {
    io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
    await appendStatus(site, key, 'resume-failed', { error: e.message });
  }
}

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
// The board's launch passes on built, the built board's items, as one call on each Auto check, while no hold stands:
// the planners a hold queued, the agents due from briefs, the landers, the rebase runs, then due's resumes (the paused
// builds domain.mjs pauseWork lets resume), the reruns the orchestrator asked for, and due's helpers (domain.mjs
// pullOf's). Each pass takes its bumped cards' launches first and stops at the first launch a hold keeps, marking the
// pass held so the minute check runs the passes again once it lifts; a hold that keeps bumped cards' launches too (a
// pause, not a busy host) ends the tick. → {held}
export async function tick(site, built, io, { resumes = [], helpers = [] } = {}) {
  io = ioOf(io);
  const pass = { held: false };
  const stopped = stoppedKeys(built);
  const bump = bumpIn(built);
  const held = (key) => heldNow(site, pass, 'claude', Boolean(bump(key)));
  const reruns = built.filter((i) => i.kind === 'work' && i.lane === 'progress' && i.agents?.some((a) => a.name === 'main' && a.rerun)).map((i) => i.key);
  const passes = [
    () => launchQueuedPlanners(site, built, io, pass),
    () => launchBriefs(site, built, io, pass),
    () => launchLanders(site, built, stopped, io, pass),
    () => launchRebases(site, built, stopped, io, pass),
    // pauseWork orders the resumes.
    async () => { for (const key of resumes) { if (held(key)) return; await resumeBuild(site, key, io); } },
    async () => { for (const key of byBump(reruns, bump)) { if (held(key)) return; await rerunBuild(site, key, io); } },
    async () => {
      for (const { key, name } of byBump(helpers, (h) => bump(h.key))) {
        if (held(key)) return;
        io.stale();
        await launchHelper(site, key, name, io);
      }
    },
  ];
  for (const run of passes) {
    if (heldNow(site, pass, 'claude', true)) break;
    await run();
  }
  return pass;
}

// Whether a pull may start the card: no open build record that may still run, and no tracked builder whose process lives.
export async function unstarted(site, key) {
  const tracked = (await readJSON(fileOf(site, TRACKED), {}))[key];
  return !hasBuilder(await openRuns(site, key)) && !(tracked?.pid && pidAlive(tracked.pid));
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
// pid null. launch({key, kind, model}) → {pid, log}. The bumped cards' builds (bumpOf(key), the card's bump or null)
// go first, the earliest bump first, and held(kind, bumped) reads whether a hold keeps a bumped card's
// (docs/adr/2026-11-19-0242-a-bump-goes-first-in-every-queue.md).
// → the tracked map as it now stands.
export async function reviveBuilders(tracked, open, { launch, handBack, alive: lives = pidAlive, held = () => false, stopped = new Set(), paused = new Set(), limitedUntil = () => null, atLimit = async () => {}, bumpOf = () => null }) {
  const next = {};
  for (const [key, entry] of byBump(Object.entries(tracked), ([k]) => bumpOf(k))) {
    if (!open.has(key)) continue;
    if (stopped.has(key)) { next[key] = { ...entry, handedBack: true }; continue; }
    if (paused.has(key) || (entry.pid !== null && lives(entry.pid)) || entry.handedBack) { next[key] = entry; continue; }
    const card = { key, ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.model ? { model: entry.model } : {}) };
    const until = entry.pid !== null ? limitedUntil(entry) : null;
    if (until) { await atLimit(card, until); next[key] = { ...entry, pid: null }; continue; }
    if (held(entry.kind ?? 'claude', Boolean(bumpOf(key)))) { next[key] = entry; continue; }
    if (entry.pid !== null && entry.relaunched) { await handBack(card); next[key] = { ...entry, handedBack: true }; continue; }
    const { key: _, ...kept } = card;
    next[key] = { ...kept, ...(await launch(card)), relaunched: entry.pid !== null || Boolean(entry.relaunched) };
  }
  // In tracked's own order, so the launch order alone is no change to write.
  return Object.fromEntries(Object.keys(tracked).filter((key) => Object.hasOwn(next, key)).map((key) => [key, next[key]]));
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
      await appendStatus(site, card.key, 'exited-twice');
    };
    const relaunch = async (card) => {
      const was = tracked[card.key];
      const entry = { call: 'relaunch', key: card.key, inputs: was,
        reason: was.pid === null ? 'Its launch was held by a pause or a busy host, which has lifted.' : 'Its builder exited with its record open, for the first time.' };
      try {
        const launched = await launchBuilder(site, card, { launch: io.launch });
        io.log({ ...entry, result: launched ? (was.pid === null ? 'launched' : 'relaunched') : 'claimed elsewhere' });
        return launched ? { pid: launched.pid, log: launched.log } : { pid: was.pid, log: was.log };
      } catch (e) {
        io.log({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
        await appendStatus(site, card.key, 'relaunch-failed', { error: e.message });
        return { pid: null };
      }
    };
    // The run the limit stopped is the same pause, resumed in its own session once the limit resets.
    const atLimit = async (card, until) => {
      io.log({ call: 'relaunch', key: card.key, result: 'paused', reason: `Its run stopped at the usage limit, which resets at ${until}.`, inputs: tracked[card.key] });
      await requestPause(site, card.key, { cause: 'usage', words: 'usage limit', until });
      await markPaused(site, card.key);
      io.stale();
    };
    const paused = new Set(items.filter((c) => c.builder?.pause?.paused).map((c) => c.key));
    const next = await reviveBuilders(tracked, open, { launch: relaunch, handBack, held: (kind, bumped) => heldFor(readUsageGate({ dir: site }), kind, bumped), stopped: stoppedKeys(items), paused,
      limitedUntil: (entry) => (entry.log ? runLimit(entry.log) : null), atLimit, bumpOf: bumpIn(items) });
    if (JSON.stringify(next) !== JSON.stringify(tracked)) await writeJSON(file, next, { from: tracked });
  } finally {
    reviving.delete(site);
  }
}

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
// At boot: a build the previous process started but died before launching (cutOffBuilds) that
// headless-builders.json doesn't list gets its builder now, as the pull would have launched it.
async function launchCutOffBuilds(site, io) {
  const tracked = await readJSON(fileOf(site, TRACKED), {});
  for (const started of (await cutOffBuilds(site)).filter((c) => !tracked[c.key])) {
    io.log({ call: 'launch-cut-off', key: started.key, result: 'launching', reason: 'A restart cut off the launch after its build started.', inputs: { kind: started.kind, model: started.model ?? null } });
    await handOff(site, started, io);
  }
}

// docs/adr/2026-11-15-1630-a-pulled-card-whose-launch-was-lost-launches-again.md
// A card In Progress that has no agent record (lostLaunches) had its pull cut off after the card moved and
// before its build started: it starts as the pull would have, at boot and each minute. A card moved within the last
// LOST_GRACE_MS may be a start still under way, so only boot, which has none, takes it at once. Bumped cards start
// first, and a busy host holds only the rest.
const LOST_GRACE_MS = 120000;
async function launchLostBuilds(site, built, io, grace) {
  const gate = readUsageGate({ dir: site });
  if (heldFor(gate, 'claude', true)) return;
  const items = await built();
  const bump = bumpIn(items);
  const blocked = new Set(items.filter((c) => c.blockedBy?.length).map((c) => c.key));
  const lost = (await lostLaunches(site, new Date(Date.now() - grace).toISOString())).filter((k) => !blocked.has(k));
  for (const key of byBump(lost, bump)) {
    if (heldFor(gate, 'claude', Boolean(bump(key)))) return;
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

// ---- A run's record ----
// One record per agent on an item: agents/<id>.json for agent main, agents/<id>@<agent>.json for any other
// (server.mjs readAgents reads both). dir, when given, is the directory holding the item file; the item is not looked up.
async function builderFile(site, key, dir, agent = 'main') {
  const { id } = parseKey(key);
  if (!/^[\w-]{1,40}$/.test(agent)) fail(`--agent takes a name of letters, digits, "_" and "-", not "${agent}"`);
  const name = agent === 'main' ? `${id}.json` : `${id}@${agent}.json`;
  if (dir) return path.join(path.resolve(dir), 'agents', name);
  const { source } = await loadItem(site, key);
  return path.join(source.dir, 'agents', name);
}
const isoTime = (v, name) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fail(`${name} takes an ISO time such as 2026-10-23T16:30:00-07:00`));

// A progress line is a phase and a detail of at most DETAIL_CAP characters, the room a status line leaves once its head
// ("Codex checking: ") takes its part; a longer one is refused by lineFault, never cut
// (docs/adr/2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md). The phases are In Progress's
// (domain.mjs PHASES).
const BUILD_PHASES = PHASES.progress;
const DETAIL_CAP = BRIEF_LINE_LIMIT - 20;
const PHASE_LIST = 'reading, building, checking or landing';
// A planner's line takes no phase: it reads its kind's word, and a --phase passed for one is dropped
// (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
function progressLine(site, phase, detail, name) {
  if (!site) fail(`${name} needs --site, since the line goes to the item's thread`);
  if (phase !== undefined && !BUILD_PHASES.includes(phase)) fail(`--phase takes ${PHASE_LIST}, not "${phase}"`);
  const words = text(detail, name);
  const long = lineFault(words, DETAIL_CAP);
  if (long) fail(`${name} ${long}. Say it shorter.`);
  return { phase, detail: words };
}
const forAgent = (line, planner, name) => {
  if (planner) return { detail: line.detail };
  if (line.phase === undefined) fail(`${name} needs --phase ${PHASE_LIST}`);
  return line;
};

// A status line lives only in the item's thread, as {kind: 'status'} (domain.mjs builderOf reads it). A progress line
// keeps its phase and reads "Building: <detail>", or "Codex building: <detail>" for an agent other than main, named by
// its kind, or by its name for a helper ("Tests building: <detail>"). A line that repeats the thread's last status line is skipped.
// A planner's line is marked planner and led by its kind's word, whichever agent it runs as ("Prototyping: …")
// (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md,
// docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
async function statusToThread(site, key, agent = 'main', builder, { phase, detail }, ts, { live = false } = {}) {
  const planner = plans(builder);
  const who = planner || agent === 'main' ? '' : builder.kind === HELPER ? agent : modelName(builder) || builder.kind || agent;
  const head = planner ? PLANNER_WORD[builder.kind] : [who, phase].filter(Boolean).join(' ');
  const repeat = new RegExp(`^(?:${head}|${phase ?? head})\\s*:?\\s+`, 'i');
  const body = head ? `${head[0].toUpperCase()}${head.slice(1)}: ${detail.replace(repeat, '')}` : detail;
  const file = threadFile(site, key);
  if ((await readLog(file)).filter((m) => m.kind === 'status').pop()?.text === body) return;
  await appendLine(file, { ts, who: 'claude', kind: 'status', run: builder.started, ...(phase ? { phase } : {}), ...(planner ? { planner: true } : {}), ...(live ? { live: true } : {}), text: body });
}

// The thread's status line for a card whose open run ended on Claude's login error: LOGGED_OUT_WORDS, once until another
// status line follows it (statusToThread skips a repeat of the last one).
export async function noteLoggedOut(site, key) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  const run = records.filter((r) => r?.started && !r.done && r.session?.log).sort((a, b) => Number(builds(b)) - Number(builds(a)))[0];
  if (run) await statusToThread(site, key, 'main', run, { detail: LOGGED_OUT_WORDS }, new Date().toISOString());
}

// The card's newest build record, a lander's included: a lander's run folds into the build it lands (domain.mjs sectionOf),
// and after a failed land its record is the card's only live one. A status line written with no run while a record is
// open would draw loose, so that is an error; with no record open there is no run to keep (a card never built).
async function newestBuild(site, key) {
  const { source } = await loadItem(site, key);
  const records = (await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)))).filter((r) => r?.started);
  const newest = records.filter(builds).sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
  if (!newest && records.some((r) => !r.done)) fail(`${key} has an open run but no build to keep a status line's run`);
  return newest ?? {};
}

// docs/adr/2026-11-13-2030-a-test-run-reports-live-lines-the-thread-does-not-show.md
// A test run's words for a card, under phase (building for a builder's run, landing for a land's): {start, update, end},
// each taking words and writing them as the card's newest status line, as `builder progress` does for the card's open
// build (or its newest, once handed back). The start and the result stay in the thread; an update is a live line, which sets the card's line and keeps a
// running build from reading stale but is not shown in the thread (domain.mjs threadOf).
export async function testReport(site, key, { phase }) {
  // Like the landing line, it joins the section of the card's newest build, which is closed once the build handed back.
  const record = await newestBuild(site, key);
  const say = (live) => async (words) => {
    const line = progressLine(site, phase, words, 'a test report');
    await statusToThread(site, key, 'main', record, line, new Date().toISOString(), { live });
  };
  return { start: say(false), update: say(true), end: say(false) };
}

// The key of the card whose open build keeps the worktree at dir, or null.
export async function cardOfWorktree(site, dir) {
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const it of itemFile?.items ?? []) {
      const records = await Promise.all((await builderFiles(source.dir, it.id)).map((f) => readJSON(f, null)));
      if (records.some((r) => r?.started && !r.done && r.worktree?.path === path.resolve(dir))) return `${source.slug}/${it.id}`;
    }
  }
  return null;
}

// The model a planner runs without --model (owner, #111's grill).
// A visual agent writes one page and should come back fast (owner, gh298-agent). A reviewer hunts for what is wrong,
// which takes the stronger model.
const PLANNER_MODEL = { prototype: 'sonnet', grill: 'opus', [VISUAL]: 'sonnet', [REVIEWER]: 'opus' };

// worktree, when given, makes the builder's worktree once every flag has passed (board/worktree.mjs makeWorktree), told
// the worktrees the card's other open builder records keep ({busy: [path]}), and returns {path, branch, repo}, which the
// record keeps for `board.mjs land`, and remade, the line saying it remade a leftover worktree, which goes in the output
// and the card's thread. A build (--kind build, claude or codex) on an
// open card marks it building first, refusing what item set --status building refuses
// (docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md).
// dispatch marks the record open before its agent runs, as dispatched: 'tap' for the owner's Build tap
// (startTappedBuild), 'hub' for a pull or a planner the board server starts
// (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md), or 'session' for the session's --dispatch right before it launches some other agent. A
// builder's own start on that open record takes it up: --kind build keeps the record's kind, its Claude model and
// worktree stay, and the record starts again at now, no longer dispatched. A session's dispatch on a record the tap
// opened leaves it as it is, and a start under another agent name refuses until main's tap-opened record is taken up
// (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md,
// docs/adr/2026-11-03-0513-the-session-opens-the-builder-record-when-it-dispatches-an-agent.md,
// docs/adr/2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md).
// A build's start clears the card's Next.
// worktree makes the card's worktree (board/worktree.mjs boardWorktree), as --worktree and the tap ask. ownWorktree makes
// it only for a main build whose record keeps none, so every build on a board works in a worktree
// (docs/adr/2026-10-30-1654-every-builder-works-in-a-worktree.md, docs/adr/2026-11-03-1842-more-of-the-skill-moves-into-code.md).
// A Claude build takes the hub's Claude model when it is Opus or Sonnet, refusing a --model it rules out, and otherwise
// the pick's, which reads the card's size and model (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md).
// → {file, lines, kind, model, reason, worktree}: model is the Claude model or null, reason the pick's, worktree the path or null;
// {file, alreadyOpen: true, lines: []} for a session's dispatch on a record the tap opened.
export async function startBuilder(site, key, { label, phase, progress, dir, agent = 'main', kind, model, eta, worktree, ownWorktree, dispatch, brief, target }) {
  if (phase !== undefined && progress === undefined) fail('--phase goes with --progress "<detail>"');
  const asLine = optional(progress, (v) => progressLine(site, phase, v, '--progress'));
  const file = await builderFile(site, key, dir, agent);
  const now = new Date().toISOString();
  const given = optional(kind, (v) => (/^[\w.-]{1,30}$/.test(v) ? v : fail('--kind takes a short word such as claude or codex')));
  // A legacy --kind opus or sonnet is kind claude with that model.
  const asked = providerOf(given);
  const askedModel = model ?? (given === 'opus' || given === 'sonnet' ? given : undefined);
  // docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md: --kind build takes the pick's kind.
  const build = ['build', ...PICKED].includes(asked);
  const before = await readJSON(file, null);
  const tapOpen = (record) => ['tap', 'hub'].includes(record?.dispatched) && !record.done;
  if (dispatch === 'session' && tapOpen(before)) return { file, alreadyOpen: true, lines: [] };
  // A visual agent, a reviewer or a helper runs beside any other, the tap's record included.
  if (agent !== 'main' && !beside({ kind: given }) && given !== HELPER && tapOpen(await readJSON(await builderFile(site, key, dir), null))) fail(`the Implement tap opened ${key}'s main builder record and no agent has taken it up; run builder start ${key} without --agent first`);
  const takeUp = before?.dispatched && !before.done ? before : null;
  const was = build && !dir ? (await loadItem(site, key)).item : undefined;
  const marking = build && !dir && !(await shownCard(site, key)).finished && was.lane !== 'progress';
  // docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a card goes into In Progress titled as its PR will be.
  const untitled = marking && startTitleFault(key, was.title);
  if (untitled) fail(untitled, startTitleBrief(was.title));
  // A record with unverified judgment calls is a build not yet checked: a start on it resumes that build, a
  // dispatched one included (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
  const resumed = before && unverifiedCalls(before).length ? before : null;
  const pick = takeUp && asked === 'build' ? { kind: providerOf(takeUp.kind), model: takeUp.model, reason: { tap: "The owner's Build tap picked it.", hub: "The board's pull picked it." }[takeUp.dispatched] ?? "The session's dispatch picked it." } : build ? builderPick({ card: was ?? {} }) : null;
  if (pick && asked !== 'build' && asked !== pick.kind) fail(`--kind ${asked}: ${pick.kind} builds now. ${pick.reason} Pass --kind ${pick.kind}, or --kind build.`);
  const k = pick ? pick.kind : asked;
  // docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md: each kind is held by its own usage.
  const gate = readUsageGate({ dir: site });
  // docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md: a start that takes up a dispatched record isn't held, the dispatch was the gate.
  // A busy host holds no bumped card's start (heldOn); a --dir record has no board card to be bumped.
  if (!(takeUp && !dispatch) && (dir ? heldFor(gate, k) : await heldOn(gate, site, key, k))) throw new BoardError(pauseReasonFor(gate, k));
  const line = asLine && forAgent(asLine, plans({ kind: k }), '--progress');
  if (model !== undefined && !['opus', 'sonnet'].includes(model)) fail('--model takes opus or sonnet');
  if (askedModel !== undefined && k === 'codex') fail('--model is for kind claude; codex needs none');
  if (k === 'claude') refuseUnforced(askedModel);
  const claude = k === 'claude' ? askedModel ?? pick?.model ?? (takeUp && providerOf(takeUp.kind) === 'claude' ? takeUp.model : undefined) ?? 'opus'
    : plans({ kind: k }) ? askedModel ?? (takeUp?.kind === k ? takeUp.model : undefined) ?? PLANNER_MODEL[k]
    : k === HELPER ? askedModel ?? before?.model : undefined;
  const record = {
    label: label === undefined ? 'Builder' : text(label, '--label'), ...(k ? { kind: k } : {}), ...(claude ? { model: claude } : {}), started: now,
    ...(eta === undefined ? {} : { eta: isoTime(eta, '--eta') }), ...(dispatch ? { dispatched: dispatch } : {}),
    ...(resumed ? { calls: resumed.calls, ...(resumed.verified ? { verified: resumed.verified } : {}) } : {}),
    // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md: a lander's record keeps the verification
    // it lands, so a lander that stops partway hands the card back still verified (relaunchLander).
    ...(!resumed && label === LANDER && before?.verified ? { verified: before.verified } : {}),
    ...(launchedSession(before) ? { session: before.session } : {}),
    // A planner's or visual agent's record keeps the brief the board launched it from (startPlanner, startVisual).
    ...((brief ?? takeUp?.brief) && plans({ kind: k }) ? { brief: brief ?? takeUp.brief } : {}),
    // A reviewer's record keeps what it reviews, diff or plan (startReviewer).
    ...((target ?? takeUp?.target) && k === REVIEWER ? { target: target ?? takeUp.target } : {}),
    // A helper's record keeps what agent launch asked of it.
    ...(k === HELPER && before?.kind === HELPER ? { label: before.label, task: before.task, writes: before.writes, requested: before.requested } : {}),
  };
  const marked = marking ? await setItem(site, key, { start: true }) : { lines: [] };
  let wt;
  let remade = null;
  // A build started again on the card keeps the worktree its last record left, while that is still there.
  // So does one kept on the item file entry, which no record keeps.
  const left = ownWorktree && build && agent === 'main' ? [before?.worktree, was?.worktree].find((w) => w?.path && existsSync(w.path)) ?? null : null;
  const kept = (takeUp ?? resumed)?.worktree ?? left;
  const make = worktree ?? (build && agent === 'main' && !kept ? ownWorktree : undefined);
  try {
    if (make) {
      const others = await builderFiles(path.dirname(path.dirname(file)), parseKey(key).id);
      const busy = (await Promise.all(others.filter((f) => f !== file).map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path && !r.done).map((r) => r.worktree.path);
      ({ remade, ...wt } = await make({ busy }));
    } else wt = kept;
  } catch (e) {
    // A worktree that can't be made leaves the card unstarted, as it was.
    if (marking) await restoreLane(site, key, was);
    throw e;
  }
  await keepPastRun(file, before);
  await writeJSON(file, wt ? { ...record, worktree: wt } : record);
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: any other main build, not the
  // rebase run nor the lander of its hand-back, ends the card's rebase run, so its push isn't counted as one.
  if (was?.rebase_run && agent === 'main' && ![REBASE_LABEL, LANDER].includes(record.label)) await endRebaseRun(site, key);
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: the pick a build
  // started on, with what it read; a start taking up a dispatched record reuses the pick its dispatch recorded.
  if (pick?.inputs && site) {
    audit(boardAudit(site), { call: 'builder-pick', key, result: [k, k === 'claude' ? claude : null].filter(Boolean).join(' '), reason: pick.reason,
      inputs: { ...pick.inputs, ...(askedModel ? { askedModel } : {}), ...(dispatch ? { dispatch } : {}) } });
  }
  if (remade && site) await appendStatus(site, key, 'worktree-remade');
  if (line) await statusToThread(site, key, agent, record, line, now);
  const resolved = beside({ kind: given }) || given === HELPER ? [] : await resolveAnswered(site, key, 'Acted on: builder started');
  if (site && build) await clearNext(site, key);
  return {
    file, kind: k ?? null, model: claude ?? null, reason: pick?.reason ?? null, worktree: wt?.path ?? null,
    lines: [...(asked === 'build' ? [`kind: ${k}. ${pick.reason}`] : []), ...(modelName(record) ? [`model: ${modelName(record)}`] : []), ...(site ? [`ref: ${await cardName(site, key)}`] : []), ...(wt ? [`worktree: ${wt.path}`] : []), ...(remade ? [remade] : []), ...marked.lines, ...resolved],
  };
}

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
// A start over a finished main record keeps that run beside it as agents/<id>@past-<started ms>.json, so the thread still
// folds its lines into a section. The copy holds the run's label, kind, model, times, log and summary, so its Builder
// message stays in the thread (docs/adr/2026-11-16-0830-a-builder-hands-back-with-a-summary-message.md), never its
// calls, worktree or hand-back, which belong to the open record.
async function keepPastRun(file, before) {
  if (!before?.started || !before.done || !file.endsWith('.json') || path.basename(file).includes('@')) return;
  const { label, kind, model, started, done, session, summary } = before;
  const past = path.join(path.dirname(file), `${path.basename(file, '.json')}@past-${Date.parse(started)}.json`);
  await writeJSON(past, { label, ...(kind ? { kind } : {}), ...(model ? { model } : {}), started, done, ...(session?.log ? { session: { log: session.log } } : {}), ...(summary ? { summary } : {}) });
}

// The owner's Build tap, in the board server: it refuses what a build's builder start refuses, in the owner's words,
// else starts the build as `builder start --kind build --worktree` does, with the record marked dispatched: 'tap', so the
// card is In Progress reading "starting" until its builder's first status line. A refusal is a status line
// of kind BUILD_REFUSED, which the Todo card shows while it is the card's newest line. worktree makes the worktree, as
// builder start's does (board/worktree.mjs boardWorktree). → {key, ref, kind, reason, worktree}, or null when refused
// (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md).
// A card an unfinished dep blocks is bumped instead, with no record and no worktree (bumpBlocked), and so is a tap with
// every implementer slot taken (full, domain.mjs pullOf), for the pull to take first once one frees. → {key, ref, bumped:
// [what it waits on], line} (docs/adr/2026-11-05-0802-todo-has-no-queue.md,
// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
// dispatch 'hub' is a pull the board server starts itself, or a resume on a card already In Progress.
export async function startTappedBuild(site, key, worktree, dispatch = 'tap', { full = false } = {}) {
  try {
    const { held, blockers } = await tapRefusals(site, key);
    if (held) await recordOwnerTap(site, 'card-hold', { key, hold: false });
    if (blockers.length) return await bumpBlocked(site, key, blockers);
    if (full) return await bumpBlocked(site, key, ['a free implementer slot']);
    try {
      const started = await startBuilder(site, key, { kind: 'build', worktree, dispatch });
      return { key, ref: await cardName(site, key), kind: started.kind, ...(started.model ? { model: started.model } : {}), reason: started.reason, worktree: started.worktree };
    } catch (e) {
      if (held) await restoreHold(site, key, held);
      throw e;
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await appendStatus(site, key, BUILD_REFUSED, { why: e.message, brief: e.brief });
    return null;
  }
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The board server's rebase run on a card whose open PR conflicts ({pr, conflict}, domain.mjs rebasesDue): the card's
// main builder record opens dispatched 'hub' and labelled Rebase, in the worktree its last build kept, else the one
// worktree makes from the PR's branch, and the card records rebase_run {pr, base, conflict, at} until the run's push
// (recordRebase). → {key, kind, model, worktree}, as startTappedBuild's
export async function startRebase(site, key, { pr, conflict, base }, worktree) {
  const { source, itemFile, item } = await loadItem(site, key);
  item.rebase_run = { pr, base, conflict, at: new Date().toISOString() };
  await writeJSON(source.file, itemFile);
  try {
    const started = await startBuilder(site, key, { kind: 'build', label: REBASE_LABEL, dispatch: 'hub', ownWorktree: worktree });
    return { key, kind: started.kind, ...(started.model ? { model: started.model } : {}), worktree: started.worktree };
  } catch (e) {
    await endRebaseRun(site, key);
    throw e;
  }
}
// The label a rebase run's builder record carries.
export const REBASE_LABEL = 'Rebase';
async function endRebaseRun(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  delete item.rebase_run;
  await writeJSON(source.file, itemFile);
}
// The number of the card's PR in its board's repo, which a finish pushes to instead of opening one, or null.
export async function cardPR(site, key) {
  const { itemFile, item } = await loadItem(site, key);
  const repo = boardRepoOf(site, itemFile);
  return cardPRs(item, repo).find((p) => p.repo === repo)?.number ?? null;
}
// A push to the card's open PR: from a rebase run (rebase_run), recorded in rebased [{from, to, base, replayed, at}], the
// commits the run pushed, replayed when the push only replayed the PR's commits onto the base (finish.mjs), which
// mergeCard then counts as trivial after an approval. → whether it was a rebase run's
export async function recordRebase(site, key, { from, to, replayed }) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.rebase_run) return false;
  item.rebased = [...(item.rebased || []), { from, to, base: item.rebase_run.base, replayed, at: new Date().toISOString() }];
  delete item.rebase_run;
  await writeJSON(source.file, itemFile);
  return true;
}
// Whether the card's rebase-only pushes lead from the approved commit to head, so only the board's rebases came after it.
// A run's push that added commits of its own breaks the chain.
export const onlyRebased = (item, approved, head) => {
  const steps = new Map((item.rebased || []).filter((r) => r.replayed).map((r) => [r.to, r.from]));
  for (let at = head, seen = 0; at && seen <= steps.size; at = steps.get(at), seen++) if (at === approved) return true;
  return false;
};

// The refusals of a build's start that the owner can act on, worded for the card; startBuilder still makes every check.
// A card the owner blocked that hasn't started is no refusal: the tap leaves the block (docs/adr/2026-11-16-1030-implement-stages-a-blocked-card-and-keeps-the-block.md),
// and nor is a blocked one: the tap bumps it (docs/adr/2026-11-05-0802-todo-has-no-queue.md).
// → {held: the owner's block as stored, or null, blockers: the names of its unfinished deps and its blocked-until condition (blockerNames)}.
async function tapRefusals(site, key) {
  const gate = readUsageGate({ dir: site });
  if (holdsWork(gate)) fail(pauseReason(gate));
  const { item } = await loadItem(site, key);
  const held = item.held ? { held: item.held, pick_up_at: item.pick_up_at, held_at: item.held_at } : null;
  if (held && leftTodo(item)) fail("it's blocked. Unblock it, then tap Implement.");
  if (await unpickedPrototype(site, key)) fail('no take is picked on its prototypes, so it prototypes again. Pick a take from the next round, then tap Implement.');
  return { held, blockers: blockerNames(await shownCard(site, key)) };
}

// docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md
// A bare Implement, in the board server with no event: the card staged as an Implement with text stages it
// (stageImplement), for the orchestrator's review before it goes ready. "Marked as staged" is the thread's whole
// answer to the tap (docs/adr/2026-11-12-1100-an-implement-tap-reads-only-marked-as-staging.md).
export async function implementAsIs(site, key, sendId) {
  return stageImplement(site, key, { sendId });
}

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
// An Implement on a card that can't start while blockers (their names) are unfinished: the card is bumped to the top of
// Todo (card-bump), where the pull takes it once nothing blocks it, and its thread says so. → {key, ref, bumped, line}.
async function bumpBlocked(site, key, blockers) {
  const names = blockers.join(', ');
  await appendEvent({ dir: site }, 'card-bump', { key });
  await appendStatus(site, key, 'cant-start-yet', { names });
  return { key, ref: await cardName(site, key), bumped: blockers, line: `bumped: ${key} waits on ${names}, so it stays in Todo, bumped to the top` };
}

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// A card pause rides on the card's open main build record as pause {cause, words, at, by?, until?, paused?, phase?}:
// cause blocked, held, usage or bumped (domain.mjs PAUSE_CLEARS), words what the card reads after "pausing · "
// ("blocked by #61"), by the card a bump-out made room for, until the reset of the usage limit that stopped the run.
// The builder's next progress report, call or ask is its stopping point (builderReply): the record reads paused at its
// phase, and the reply tells it to commit and stop. The board server resumes it once nothing pauses it (server.mjs).
async function openBuild(site, key) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  return record?.started && !record.done && builds(record) ? { file, record } : null;
}

// Asks the card's running build to pause for cause; one already pausing keeps its first cause. → whether it asked
export async function requestPause(site, key, { cause, words, by, until }) {
  const open = await openBuild(site, key);
  if (!open || open.record.pause) return false;
  await writeJSON(open.file, { ...open.record, pause: { cause, words, at: new Date().toISOString(), ...(by ? { by } : {}), ...(until ? { until } : {}) } });
  return true;
}

// Marks the card's pausing build paused at the newest phase its build reported, with the thread line saying so.
// → its pause, or null when none was asked
export async function markPaused(site, key) {
  const open = await openBuild(site, key);
  const pause = open?.record.pause;
  if (!pause || pause.paused) return pause ?? null;
  const at = new Date().toISOString();
  const phase = (await readLog(threadFile(site, key))).filter((m) => m.kind === 'status' && m.phase && !m.planner && String(m.ts) >= String(open.record.started)).pop()?.phase;
  const paused = { ...pause, paused: at, ...(phase ? { phase } : {}) };
  await writeJSON(open.file, { ...open.record, pause: paused });
  await appendStatus(site, key, 'paused', { phase, words: pause.words, clear: PAUSE_CLEARS[pause.cause][0] });
  return paused;
}

// What the board says to the card's main builder after its own command (progress, call, ask, asks --wait): the news
// waiting for it (takeNews), then, at a stopping point it reached while a pause was asked, the reply that stops it, its
// record marked paused (markPaused). → its lines, none while neither waits
async function builderReply(site, key, { dir, agent = 'main' }) {
  if (!site || dir || agent !== 'main') return [];
  const news = await takeNews(site, key);
  const pause = await markPaused(site, key);
  return [...news, ...(pause ? [`Paused: ${pause.words}. Commit what you have now with \`git -c core.commentChar=';' commit -F <file>\`, then stop: end your turn and run nothing else. The board resumes this session, telling it so, once the pause clears.`] : [])];
}

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
// News is what reached a card In Progress for its builder after the build started: the orchestrator's builder resume,
// the owner's thread message, a notes section added. It waits on the card's main build record, running or handed back,
// as news [{at, from: orchestrator|owner|notes, text}], until it reaches the builder: a running one at its next command
// (builderReply), its PostToolUse hook (hooks-plugin board-messages.mjs, through data/builder-news/<session id>.json,
// which names the card), or the refusal of its builder done; a handed-back one in the brief it is resumed with (takeRerun).
const NEWS_FROM = { orchestrator: 'the orchestrator wrote: ', owner: 'the owner wrote: ', notes: 'its notes gained ' };
const newsPointer = (site, session) => path.join(site, 'data', 'builder-news', `${session}.json`);
const newsLines = (key, news) => [...news.map((n) => `New on ${key} while you build: ${NEWS_FROM[n.from]}${n.text}`),
  'Take it in before you hand back: build to it, and where it contradicts your notes, ask with builder ask.'];

// The card's main build record news reaches: one running, or one handed back. → {file, record} or null
async function newsBuild(site, key) {
  const { item } = await loadItem(site, key);
  if (item.lane !== 'progress') return null;
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  return record?.started && builds(record) && (!record.done || record.handed_back) ? { file, record } : null;
}

// Adds news for the card's builder, when it has a running or handed-back build. → whether it did
export async function passNews(site, key, { from, text: said }) {
  const build = await newsBuild(site, key);
  if (!build) return false;
  const { file, record } = build;
  await writeJSON(file, { ...record, news: [...(record.news || []), { at: new Date().toISOString(), from, text: said }] });
  if (!record.done && record.session?.id) await writeJSON(newsPointer(site, record.session.id), { key });
  return true;
}

// The news waiting for the card's running build, taken off its record. → its lines, none while none waits
export async function takeNews(site, key) {
  const open = await openBuild(site, key);
  if (!open?.record.news) return [];
  const { news, ...rest } = open.record;
  await writeJSON(open.file, rest);
  if (rest.session?.id) await remove(newsPointer(site, rest.session.id));
  return newsLines(key, news);
}

// builder done refuses the main build while news waits for it, the refusal delivering it.
export async function refuseNews(site, key) {
  const lines = await takeNews(site, key);
  if (lines.length) fail(`${lines.join('\n')}\nRun builder done again once your build takes it in.`);
}

// `builder resume <key> --text <t>`, the orchestrator's: on a running build the text is news for it, with a thread line
// saying so; on a handed-back build it is news too, and the record is marked rerun {at, text} for the board server to
// resume the builder's own session with it (takeRerun). → {running}
export async function builderResume(site, key, said) {
  needSite(site);
  const words = text(said, '--text');
  const { item } = await loadItem(site, key);
  const name = await cardName(site, key);
  if (item.lane !== 'progress') fail(`builder resume takes a task In Progress; ${name} is in ${item.lane ?? 'todo'}`);
  const build = await newsBuild(site, key);
  if (!build) fail(`${name} has no running or handed-back build to resume`);
  const { file, record } = build;
  if (!record.done) {
    await passNews(site, key, { from: 'orchestrator', text: words });
    await appendStatus(site, key, 'builder-told', { text: words });
    return { running: true };
  }
  if (providerOf(record.kind ?? 'claude') !== 'claude' || !record.session?.id) fail(`${name}'s build has no Claude session the board launched to resume; start a new build instead`);
  if (record.rerun) fail(`${name} already waits on the board to resume its builder`);
  await passNews(site, key, { from: 'orchestrator', text: words });
  await writeJSON(file, { ...(await readJSON(file, null)), rerun: { at: new Date().toISOString(), text: words } });
  return { running: false };
}

// The board server's take of a handed-back build marked rerun: the record opens again, its hand-back, rerun mark and
// news off it, the card's Next cleared, and a "Resumed: <text>" line. → {record: the record it now is, news: the news's
// lines for the resume's brief}, or null when no build is marked
export async function takeRerun(site, key) {
  const build = await newsBuild(site, key);
  if (!build?.record.rerun) return null;
  const { file, record: { done, handed_back, rerun, news = [], ...rest } } = build;
  await writeJSON(file, rest);
  await clearNext(site, key);
  await appendStatus(site, key, 'builder-rerun', { text: rerun.text });
  return { record: rest, news: newsLines(key, news) };
}

// The card's paused build resumes: its pause comes off its record, and the thread says why. → {pause: the pause it had,
// record: the record it now is}, or null when it isn't paused
export async function resumePaused(site, key) {
  const open = await openBuild(site, key);
  const pause = open?.record.pause;
  if (!pause?.paused) return null;
  const { pause: _, ...rest } = open.record;
  await writeJSON(open.file, rest);
  await appendStatus(site, key, 'resumed', { clear: PAUSE_CLEARS[pause.cause][1] });
  return { pause, record: rest };
}

// A pause whose cause cleared before its builder stopped comes off its record with no line: the build never stopped.
export async function dropPause(site, key) {
  const open = await openBuild(site, key);
  if (!open?.record.pause || open.record.pause.paused) return;
  const { pause: _, ...rest } = open.record;
  await writeJSON(open.file, rest);
}

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A build the board server started whose agent couldn't launch goes back to Todo: its open main record closes, the card
// goes back to Todo with no move line, and the thread says why, as a refusal the Todo card shows.
export async function abandonLaunch(site, key, why) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  const now = new Date().toISOString();
  if (record && !record.done) await writeJSON(file, { ...record, done: now });
  releaseLaunch(site, key);
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.lane === 'progress') placeIn(item, 'todo', now);
  await writeJSON(source.file, itemFile);
  await appendStatus(site, key, BUILD_REFUSED, { why });
}

// A planner the board server opened whose agent couldn't launch: its record, the agent's, closes and the thread says why.
// kind and inputs are its status line's (hub-lines.mjs).
export async function abandonPlanner(site, key, [kind, inputs], agent = 'main') {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  if (record && !record.done) await writeJSON(file, { ...record, done: new Date().toISOString() });
  releaseLaunch(site, key, agent);
  await publishStaged(site, key);
  await appendStatus(site, key, kind, inputs);
}

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
// The session id of the agent the board server just launched on a card (headless.mjs launchBuilder), on its builder
// record, the main one unless agent names another, as session {id, pid, log: the log file's name, at}. The agent's own builder start keeps it (launchedSession).
export async function recordSession(site, key, id, pid, agent = 'main', log = null) {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  await writeJSON(file, { ...record, session: { id, pid, log, at: new Date().toISOString() } });
}

// The card's open builder records, each as {pid, at}: the process the board server launched (null for an agent a
// session started itself) and when its session was recorded. Read before a tap closes them.
export async function openAgents(site, key) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  return records.filter((r) => r && r.started && !r.done).map((r) => ({ pid: r.session?.pid ?? null, at: r.session?.at ?? null }));
}

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The card's open builder records, each {kind, pid, at} as openAgents reads them.
export async function openRuns(site, key) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  return records.filter((r) => r && r.started && !r.done).map((r) => ({ kind: r.kind ?? null, pid: r.session?.pid ?? null, at: r.session?.at ?? null }));
}
// The orchestrator's stop of the card's run (build, land), on each open build record as stopped {run, at}: the card
// reads the stop's words, and the server relaunches neither its builder nor its lander.
export async function markStopped(site, key, run) {
  releaseLaunch(site, key);
  const { source } = await loadItem(site, key);
  const at = new Date().toISOString();
  for (const file of await builderFiles(source.dir, parseKey(key).id)) {
    const record = await readJSON(file, null);
    if (record?.started && !record.done && builds(record)) await writeJSON(file, { ...record, stopped: { run, at } });
  }
}
// The orchestrator's stop of the land a held card's Merge tap started: merge_ready.stopped, read until the next tap.
export async function stopHeldMerge(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.merge_ready) return;
  item.merge_ready.stopped = new Date().toISOString();
  await writeJSON(source.file, itemFile);
}
// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
// The orchestrator's stall of a card (item stall): stalled {reason, at} on its item file entry, which the card reads as red
// stalled and an Action needed until a message on the card clears it (clearStall). → the reason
export async function markStalled(site, key, reason) {
  const words = text(reason, 'item stall --reason');
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.lane === 'done') fail(`${await cardName(site, key)} is done; there is nothing to stall`);
  item.stalled = { reason: words, at: new Date().toISOString() };
  await writeJSON(source.file, itemFile);
  return words;
}
// A message on a stalled card clears its stall, so the card reads as it is and the message reaches the orchestrator.
export async function clearStall(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.stalled) return;
  delete item.stalled;
  await writeJSON(source.file, itemFile);
}
// The card's standing bump, which its land queues with and lets its starts pass a busy host (heldOn): its latest
// card-bump when no card-unbump came after it and it was made after the card last closed, Done or merged, as the
// board reads a bump (domain.mjs workItem), else null.
export async function landFirst(site, key) {
  const { item } = await loadItem(site, key);
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  const latest = (kind) => events.filter((e) => e.kind === kind && e.data?.key === key).map((e) => String(e.ts)).sort().pop() || '';
  const bump = latest('card-bump');
  if (!bump || latest('card-unbump') > bump) return null;
  const closedAt = [item.closed_at, ...storedPRs(item).map((p) => p.merged_at)].filter(Boolean).map(String).sort().pop() || '';
  return bump > closedAt ? bump : null;
}
// The orchestrator's bump (on) or unbump of a card, the event the owner's Bump sends. → the event's time
export async function bumpCard(site, key, on) {
  if ((await shownCard(site, key)).finished) fail(`${await cardName(site, key)} is done; there is nothing to bump`);
  const id = await appendEvent({ dir: site }, on ? 'card-bump' : 'card-unbump', { key });
  return (await readLog(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === id).ts;
}

// Whether the card's latest status line is the finish step's landing line.
export async function isLanding(site, key) {
  return (await readLog(threadFile(site, key))).filter((m) => m.kind === 'status').pop()?.phase === 'landing';
}
// A record's session belongs to the agent now starting on it when a launch wrote it since the record last started or closed.
const launchedSession = (record) => Boolean(record?.session) && record.session.at > (record.done ?? record.started);

// The board server's start of a planner, kind grill or prototype, on a card: the main record opens, dispatched: 'hub',
// as builder start --kind <kind> does, from the card's oldest written brief of that kind, which moves onto the record
// (brief, the card's briefs entry: the record is written once with it, then the card drops it), or from kept, the entry a run the Block stopped had. A card with neither is refused
// (docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md).
// → {key, kind, model, brief, ...a grill's ask, or a prototype's asks}, or null while an agent already works on the
// card's main record. A prototype entry written before entries kept asks has its one ask as asks.
export async function startPlanner(site, key, kind, kept = null) {
  const file = await builderFile(site, key);
  const open = await readJSON(file, null);
  if (open && !open.done) return null;
  if (!kept && !(await briefOn(site, key, kind))) await noBrief(site, key, kind);
  const entry = kept ?? await briefOn(site, key, kind);
  const started = await startBuilder(site, key, { kind, dispatch: 'hub', brief: entry });
  if (!kept) await dropBrief(site, key, kind);
  const asked = kind === 'prototype' ? { asks: entry.asks ?? (entry.ask ? [entry.ask] : []) } : entry.ask;
  return { key, kind, model: started.model, brief: entry.brief, ...asked };
}

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
// The board server's start of the visual agent or reviewer (kind) for the card's oldest written brief of that kind
// (domain.mjs briefsDue): its own record, agent <kind>-<the brief's time in ms>, opens dispatched 'hub' beside any other
// agent on the card, and the brief moves onto it. A reviewer reviews the diff while the card's newest worktree is on
// disk, else the plan, and its record keeps which as target. → {key, kind, model, agent, brief, target?, ...its ask}, or
// null while one of its kind runs on the card; a card with no brief of the kind is refused.
async function startBeside(site, key, kind) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  if (records.some((r) => r?.kind === kind && r.started && !r.done)) return null;
  const waiting = await briefOn(site, key, kind) ?? await noBrief(site, key, kind);
  const agent = besideAgent(kind, waiting.brief);
  const worktree = records.filter((r) => r?.worktree?.path).sort((a, b) => String(a.started || '').localeCompare(String(b.started || ''))).at(-1)?.worktree.path;
  const target = kind === REVIEWER ? (worktree && existsSync(worktree) ? 'diff' : 'plan') : undefined;
  const started = await startBuilder(site, key, { kind, agent, dispatch: 'hub', brief: waiting, target });
  await dropBrief(site, key, kind);
  return { key, kind, model: started.model, agent, brief: waiting.brief, ...(target ? { target } : {}), ...waiting.ask };
}
export const startVisual = (site, key) => startBeside(site, key, VISUAL);
export const startReviewer = (site, key) => startBeside(site, key, REVIEWER);

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// A helper's name: lowercase words joined by "-", never main nor a visual agent's or reviewer's.
const helperName = (name) => (typeof name === 'string' && /^[a-z][a-z0-9-]{0,29}$/.test(name) && name !== 'main' && !name.startsWith(`${VISUAL}-`) && !name.startsWith(`${REVIEWER}-`) ? name
  : fail('--name takes a short lowercase name such as tests or docs-pass: letters, digits and "-", not main, visual-… or reviewer-…'));
// The worktree the card's build works in, its main record's, else the one the card got on entering In Progress, while
// it is on disk; null when it has none.
async function cardWorktree(site, key) {
  const { item } = await loadItem(site, key);
  const main = await readJSON(await builderFile(site, key), null);
  return [main?.worktree, item.worktree].find((w) => w?.path && existsSync(w.path)) ?? null;
}

// A --model Hub settings' Builders (push.mjs readClaudeModel) rules out is refused while that choice is Opus or Sonnet.
function refuseUnforced(model) {
  const forced = readClaudeModel();
  if (model === undefined || forced === 'auto' || model === forced) return;
  fail(`--model ${model}: the hub's Claude model is ${forced === 'opus' ? 'Opus' : 'Sonnet'}. Pass --model ${forced}, or no --model.`);
}

// `agent launch <file/id> --name <n> --task <t> [--writes] [--model opus|sonnet]`: any session asks for a helper on an
// open card, which the board server launches headless (server.mjs launchHelpers) at once, on its card's implementer
// slot (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md). Its record,
// agents/<id>@<name>.json, opens requested: {kind: helper, label: name, task, writes, model?, requested}, with no
// start until the server's. --model is a Claude model, refused when the hub's Claude model rules it out; without one
// the server takes builder pick's, as a build does. A helper that writes needs the card's worktree, since its own
// branches from the card's branch. → {lines}
export async function requestHelper(site, key, { name, task, writes, model }) {
  needSite(site);
  const agent = helperName(name);
  const job = text(task, '--task');
  if (model !== undefined && !['opus', 'sonnet'].includes(model)) fail('--model takes opus or sonnet');
  refuseUnforced(model);
  if ((await shownCard(site, key)).finished) fail(`${await cardName(site, key)} is Done; a helper needs an open task`);
  const file = await builderFile(site, key, undefined, agent);
  if (existsSync(file)) fail(`${key} already has an agent named ${agent}; pick another --name`);
  if (writes && !(await cardWorktree(site, key))) fail(`a helper that writes branches from ${key}'s worktree, and the task has none; start its build first, or drop --writes`);
  await writeJSON(file, { label: agent, kind: HELPER, task: job, writes: Boolean(writes), ...(model ? { model } : {}), requested: new Date().toISOString() });
  await appendStatus(site, key, 'helper-asked', { agent, writes });
  return { lines: [`helper ${agent} requested: the board launches it now`, `wait for it with agent wait ${key} --name ${agent}`] };
}

// The board server's start of helper name on the card, which domain.mjs pullOf let launch: its record opens dispatched
// 'hub' on builder pick's Claude model unless agent launch gave one, and one that writes gets its own worktree, made by
// make({repo, base, busy}) from the card's worktree's branch (board/worktree.mjs makeWorktree). → {key, kind, model,
// agent, task, writes, worktree}, worktree the helper's own path or null, or null when the record is no longer a
// requested helper.
export async function startHelper(site, key, name, make) {
  const file = await builderFile(site, key, undefined, name);
  const asked = await readJSON(file, null);
  if (asked?.kind !== HELPER || asked.started || asked.done) return null;
  const { item } = await loadItem(site, key);
  const pick = builderPick({ card: item });
  const forced = readClaudeModel();
  const model = asked.model ?? (forced !== 'auto' ? forced : pick.kind === 'claude' ? pick.model : 'opus');
  const tree = asked.writes ? await cardWorktree(site, key) : null;
  if (asked.writes && !tree) fail(`${key} has no worktree for helper ${name} to branch from`);
  await writeJSON(file, { ...asked, model });
  const started = await startBuilder(site, key, { agent: name, kind: HELPER, dispatch: 'hub', worktree: tree ? ({ busy }) => make({ repo: tree.repo, base: tree.branch, busy }) : undefined });
  return { key, kind: HELPER, model, agent: name, task: asked.task, writes: asked.writes, worktree: started.worktree };
}

// What a helper's spawner reads of it: {record, card} with card the card's worktree (cardWorktree), refusing a name
// that is no helper on the card.
export async function helperOf(site, key, name) {
  const record = await readJSON(await builderFile(site, key, undefined, helperName(name)), null);
  if (record?.kind !== HELPER) fail(`${key} has no helper named ${name}`);
  return { record, card: await cardWorktree(site, key) };
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// `agent wait <file/id> --name <n> [--agent <spawner>] [--timeout <minutes>]`: blocks until helper name is done, then
// prints its hand-back, and for one that writes its branch to merge. While it waits, the spawner's open record carries
// waits: name, so the spawner doesn't count as running (domain.mjs pullOf idle). It
// gives up after timeout minutes (9, under a Bash tool call's 10), saying what the helper is doing, and refuses once
// the helper's process has gone without its done. alive(pid) says whether a process runs. It polls every ms, its
// deadline read off now(). → {lines}
export async function waitHelper(site, key, { name, agent = 'main', timeout = 9, every = 2000, now = Date.now, alive }) {
  needSite(site);
  const minutes = Number(timeout);
  if (!(minutes > 0)) fail('--timeout takes minutes, a number above 0');
  const helperFile = await builderFile(site, key, undefined, helperName(name));
  const spawnerFile = await builderFile(site, key, undefined, agent);
  const mark = async (waits) => {
    const spawner = await readJSON(spawnerFile, null);
    if (!spawner?.started || spawner.done) return;
    const { waits: _, ...rest } = spawner;
    await writeJSON(spawnerFile, waits ? { ...rest, waits } : rest);
  };
  const deadline = now() + minutes * 60_000;
  await mark(name);
  try {
    for (;;) {
      const helper = await readJSON(helperFile, null);
      if (helper?.kind !== HELPER) fail(`${key} has no helper named ${name}`);
      if (helper.done) {
        const tree = helper.writes && helper.worktree ? [`branch ${helper.worktree.branch} in ${helper.worktree.path}: merge it with agent merge ${key} --name ${name}`] : [];
        return { lines: [`helper ${name} done: ${helper.note ?? 'no hand-back'}`, ...tree] };
      }
      // A helper's name is never reused, so the session on its record is its own launch's.
      const pid = helper.session?.pid ?? null;
      if (pid && !alive(pid)) fail(`helper ${name}'s process exited without builder done; do its task yourself`);
      if (now() >= deadline) fail(`helper ${name} is still ${helper.started ? 'running' : 'waiting to launch'} after ${minutes} minutes; run agent wait again`);
      // poll: helper-wait
      await new Promise((resolve) => setTimeout(resolve, every));
    }
  } finally {
    await mark(null);
  }
}

// Whether agent's open record on the card is a helper, whose builder done hands back its --text.
export async function isHelper(site, key, agent = 'main') {
  if (agent === 'main') return false;
  return (await readJSON(await builderFile(site, key, undefined, agent), null))?.kind === HELPER;
}

// Whether agent's open record on the card is a planner's run (domain.mjs plans), whose builder done writes its --text as
// the run's closing thread line.
export async function isPlanner(site, key, agent = 'main') {
  const record = await readJSON(await builderFile(site, key, undefined, agent), null);
  return Boolean(record?.started && !record.done && plans(record));
}

// `visual add <file/id> --file <html or md> --title <t> [--implement]`: the visual agent's page, or a Markdown report
// drawn into one (markdown-page.mjs), copied to the site's
// public/visuals/<card id>/<slug of title>.html, a new name each time, and a visual line in the card's thread linking it.
// With --implement, a final visual's, the card waits on the owner's Implement as thread --implement marks it, and a
// card already staged, ready or past Todo is refused before the page is placed
// (docs/adr/2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md).
// → {lines: [the page's site-relative link]}
export async function addVisual(site, key, { file, title, implement }) {
  needSite(site);
  const name = text(title, '--title');
  if (typeof file !== 'string' || !/\.(html|md)$/.test(file)) fail('--file takes the page, an .html file, or a report, a .md file');
  const source = await fs.readFile(path.resolve(file), 'utf8').catch(() => fail(`--file ${file} can't be read`));
  if (!source.trim()) fail(`--file ${file} is empty`);
  const html = file.endsWith('.md') ? markdownPage(source, name) : source;
  await loadItem(site, key);
  if (implement) await markWaiting(site, key, 'implement');
  const { id } = parseKey(key);
  const dir = path.join(site, 'public', 'visuals', id);
  await fs.mkdir(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'visual';
  let page = `${slug}.html`;
  for (let n = 2; existsSync(path.join(dir, page)); n++) page = `${slug}-${n}.html`;
  await fs.writeFile(path.join(dir, page), html, { flag: 'wx' });
  const link = `visuals/${id}/${page}`;
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', kind: VISUAL, text: text(name, '--name'), link: pageUrl(link, '--link'), ...(implement ? { implement: true } : {}) });
  return { lines: [link] };
}

// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
// `reviewer post <file/id> --file <findings.json>`: the reviewer's findings, a JSON list of {severity: high|medium|low,
// at?: "<file>:<line>", text}, as one Reviewer message in the card's thread, most severe first (a stable sort, so the
// reviewer's order holds within a severity), headed by how many and what it reviewed, its newest reviewer record's target.
const SEVERITIES = ['high', 'medium', 'low'];
function finding(f, n) {
  const name = `finding ${n + 1}`;
  if (!f || typeof f !== 'object' || !SEVERITIES.includes(f.severity)) fail(`${name} needs severity high, medium or low`);
  return { severity: f.severity, ...(f.at === undefined ? {} : { at: text(f.at, `${name}'s at`) }), text: text(f.text, `${name}'s text`) };
}
export async function postFindings(site, key, { file }) {
  needSite(site);
  if (typeof file !== 'string') fail('reviewer post needs --file <findings.json>');
  const raw = await fs.readFile(path.resolve(file), 'utf8').catch(() => fail(`--file ${file} can't be read`));
  let list;
  try { list = JSON.parse(raw); } catch (e) { fail(`--file ${file} isn't JSON: ${e.message}`); }
  if (!Array.isArray(list)) fail(`--file ${file} holds a JSON list of findings: [{"severity": "high", "at": "<file>:<line>", "text": "<one sentence>"}]`);
  const findings = list.map(finding).map((f, i) => [f, i]).sort(([a, i], [b, j]) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || i - j).map(([f]) => f);
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  const target = records.filter((r) => r?.kind === REVIEWER && r.started).sort((a, b) => String(a.started).localeCompare(String(b.started))).at(-1)?.target || 'plan';
  const n = findings.length;
  const words = n ? `${n} finding${n === 1 ? '' : 's'} on the ${target}${n > 1 ? ', most severe first' : ''}` : `No findings on the ${target}`;
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: REVIEWER, kind: REVIEWER, text: words, findings });
  return { lines: [`${await cardName(site, key)}: ${words}, posted in its thread`] };
}

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
// The builds the board server started (a pull, a Build tap, a queued start) whose launch it never made: a card not done
// whose main build record is open with dispatched still 'tap' or 'hub', since a builder's own `builder start` clears
// that mark. Those records keep the pick's kind and model and the worktree the start made, which the launch's brief
// names. A session's dispatch ('session') is left alone: the session launches that agent itself
// (docs/adr/2026-11-14-0730-a-board-server-holds-its-port-before-it-launches-anything.md).
// → [{key, kind, model}], launchBuilder's card for each.
export async function cutOffBuilds(site) {
  const out = [];
  const open = await openKeys(site);
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      if (!open.has(`${source.slug}/${item.id}`)) continue;
      const record = await readJSON(path.join(source.dir, 'agents', `${item.id}.json`), null);
      if (!record?.started || record.done || !['tap', 'hub'].includes(record.dispatched) || plans(record)) continue;
      out.push({ key: `${source.slug}/${item.id}`, kind: providerOf(record.kind), model: record.model });
    }
  }
  return out;
}

// docs/adr/2026-11-15-1630-a-pulled-card-whose-launch-was-lost-launches-again.md
// The cards In Progress that no build ever started on: open, in the lane since before `since` (ISO time), not held by
// the owner, with no agent record of any kind in their folder. A pull that a restart cut off after it moved the card
// and before it wrote the record leaves one. → [key]
export async function lostLaunches(site, since) {
  const out = [];
  const open = await openKeys(site);
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      if (!open.has(`${source.slug}/${item.id}`) || item.lane !== 'progress' || item.held || !(item.lane_at < since)) continue;
      if ((await builderFiles(source.dir, item.id)).length) continue;
      out.push(`${source.slug}/${item.id}`);
    }
  }
  return out;
}

// A tapped build that failed to start puts back the hold the tap cleared.
async function restoreHold(site, key, was) {
  const { source, itemFile, item } = await loadItem(site, key);
  for (const field of Object.keys(was)) if (was[field] === undefined) delete item[field]; else item[field] = was[field];
  await writeJSON(source.file, itemFile);
}

async function restoreLane(site, key, was) {
  const { source, itemFile, item } = await loadItem(site, key);
  for (const field of ['lane', 'lane_at', 'closed_at', 'reopened_at', 'phase']) if (was[field] === undefined) delete item[field]; else item[field] = was[field];
  await writeJSON(source.file, itemFile);
}

// `audit [<file/id>]`: the board's audit log (shared/audit.mjs), only that card's calls when given. → {lines}
export async function auditLog(site, key) {
  if (!site) fail('audit reads a board: pass --site <route>');
  if (key !== undefined) parseKey(key);
  return { lines: auditLines(readAudit(boardAudit(site), { key })) };
}

// A Todo card whose newest line is a refused start gets a line after it, which the pull reads as the refusal cleared
// (docs/adr/2026-11-16-0500-a-refused-start-returns-the-card-to-ready.md). A retitle clears the title refusal too.
export async function clearRefusal(site, key) {
  const newest = (await readLog(threadFile(site, key))).filter((m) => !['status', MOVE].includes(m.kind)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  if (newest?.line === BUILD_REFUSED) await appendStatus(site, key, 'refusal-cleared');
}
const PICKED = ['codex', 'claude'];
// `builder pick`: the kind builder start takes for a card's build. → {lines: ["codex: <reason>" or "claude <opus|sonnet>: <reason>"]}
export async function pickBuilder(site, key) {
  const { item } = await loadItem(site, key);
  if (site && item.lane === 'todo') await clearRefusal(site, key);
  const { kind, model, reason } = builderPick({ card: item });
  return { lines: [`${[kind, model].filter(Boolean).join(' ')}: ${reason}`] };
}

// The worktree the item's newest builder record keeps ({path, branch, repo}), or null when none keeps one.
export async function recordedWorktree(site, key, { dir } = {}) {
  const { id } = parseKey(key);
  const agents = path.dirname(await builderFile(site, key, dir));
  const files = await builderFiles(path.dirname(agents), id);
  const records = (await Promise.all(files.map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path && r.kind !== HELPER);
  return records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]?.worktree ?? null;
}

// The card's newest session worth resuming, {id, worktree: the path its record keeps}: the newest builder record with
// both, a past lander's or resumed session's included, so a second land continues the newest one. Null when none has.
export async function recordedSession(site, key) {
  const { source } = await loadItem(site, key);
  const records = (await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)))).filter((r) => r?.session?.id && r.worktree?.path && r.kind !== HELPER);
  const newest = records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
  return newest ? { id: newest.session.id, worktree: newest.worktree.path, log: newest.session.log ?? null } : null;
}

export async function builderProgress(site, key, progress, { phase, dir, agent = 'main', eta, clearEta }) {
  if (eta !== undefined && clearEta) fail('pass --eta or --clear-eta, not both');
  const given = progressLine(site, phase, progress, 'builder progress');
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record?.started || record.done) fail(`builder progress needs an open builder record on ${key}; run builder start first`);
  const line = forAgent(given, plans(record), 'builder progress');
  if (eta !== undefined) record.eta = isoTime(eta, '--eta');
  if (clearEta) delete record.eta;
  if (eta !== undefined || clearEta) await writeJSON(file, record);
  await statusToThread(site, key, agent, record, line, new Date().toISOString());
  return { file, lines: await builderReply(site, key, { dir, agent }) };
}

// The finish step's own landing line, so the card's fifth bar lights while it rebases and lands, whoever finishes it.
export async function landingLine(site, key) {
  const file = threadFile(site, key);
  if ((await readLog(file)).filter((m) => m.kind === 'status').pop()?.phase === 'landing') return;
  await appendLine(file, { ts: new Date().toISOString(), who: 'claude', kind: 'status', phase: 'landing', text: 'Landing: rebasing onto main and landing', run: (await newestBuild(site, key)).started });
}

// A judgment call is one line a builder records as it decides, kept on its record as {at, text}; the session's
// `builder verified` stamps the record verified {at, note}, which covers every call made before it. land refuses while
// any record on the card has a call after its stamp
// (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
const unverifiedCalls = (record) => (record?.calls || []).filter((c) => !record.verified || c.at > record.verified.at);

export async function recordCall(site, key, call, { dir, agent = 'main' }) {
  const words = text(call, 'builder call');
  if (/\n/.test(words)) fail('builder call takes one line; record each call on its own');
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record?.started || record.done) fail(`builder call needs an open builder record on ${key}; run builder start first`);
  await writeJSON(file, { ...record, calls: [...(record.calls || []), { at: new Date().toISOString(), text: words }] });
  return { file, lines: await builderReply(site, key, { dir, agent }) };
}

// docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md
// A builder asks the orchestrator mid-build and carries on: the ask is a thread line {kind: builder-ask, ask: ask<n>,
// agent} written as "<model> builder", and a builder-ask {key, ask, agent, text} event wakes the board's session. The
// session's answer or deferral is a line {kind: builder-answer, ask, deferred?} written as claude, which the thread names
// Orchestrator; neither line is unread, pushed or answers the owner, so the card stays quiet. A deferral is also a
// "Question: …" call on the asking agent's record, so the build hands back for it, and the session's review puts it to
// the owner as a question naming the ask ("ask": "ask<n>") before `builder verified`.
// → [{id, agent, text, at, answer: {text, at} | null, deferred}], oldest first.
async function builderAsks(site, key) {
  const thread = await readLog(threadFile(site, key));
  const replies = new Map(thread.filter((m) => m.kind === BUILDER_ASK.answer).map((m) => [m.ask, m]));
  return thread.filter((m) => m.kind === BUILDER_ASK.ask).map((m) => {
    const reply = replies.get(m.ask);
    return { id: m.ask, agent: m.agent || 'main', text: m.text, at: m.ts, answer: reply ? { text: reply.text, at: reply.ts } : null, deferred: Boolean(reply?.deferred) };
  });
}

export async function askOrchestrator(site, key, question, { agent = 'main' }) {
  needSite(site);
  const words = text(question, 'builder ask');
  if (/\n/.test(words)) fail('builder ask takes one line; ask each question on its own');
  const record = await readJSON(await builderFile(site, key, undefined, agent), null);
  if (!record?.started || record.done) fail(`builder ask needs an open builder record on ${key}; run builder start first`);
  const id = `ask${(await builderAsks(site, key)).length + 1}`;
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: `${modelName(record) || record.kind || 'Claude'} builder`, kind: BUILDER_ASK.ask, ask: id, agent, text: words });
  await appendEvent(boardTarget(site), 'builder-ask', { key, ask: id, agent, text: words });
  return { id, lines: await builderReply(site, key, { agent }) };
}

// The session's reply to a builder's ask: an answer, or with deferred its deferral to the owner.
export async function answerBuilder(site, key, id, reply, { deferred = false } = {}) {
  needSite(site);
  const said = text(reply, '--text');
  const ask = (await builderAsks(site, key)).find((a) => a.id === id) || fail(`no ask "${id}" on ${key}; builder asks ${key} lists them`);
  if (ask.answer) fail(`${id} on ${key} is already ${ask.deferred ? 'deferred' : 'answered'}`);
  const now = new Date().toISOString();
  await appendLine(threadFile(site, key), { ts: now, who: 'claude', kind: BUILDER_ASK.answer, ask: id, ...(deferred ? { deferred: true } : {}), text: said });
  if (deferred) {
    const file = await builderFile(site, key, undefined, ask.agent);
    const record = await readJSON(file, null);
    if (record) await writeJSON(file, { ...record, calls: [...(record.calls || []), { at: now, text: `Question: ${ask.text} (deferred to the owner)` }] });
  }
  return { lines: [] };
}

// → {lines}: each ask, then its answer, deferral or "waiting on the orchestrator". With wait it blocks until no ask is
// waiting on the orchestrator, giving up after timeout minutes (9, under a Bash tool call's 10) so the builder runs it again.
// It polls every ms, its deadline read off now(). A builder waiting is at a stopping point, so news for it or a pause
// asked meanwhile ends the wait with its reply (builderReply).
export async function listAsks(site, key, { wait = false, timeout = 9, every = 2000, now = Date.now } = {}) {
  needSite(site);
  const minutes = Number(timeout);
  if (!(minutes > 0)) fail('--timeout takes minutes, a number above 0');
  const deadline = now() + minutes * 60_000;
  for (;;) {
    const asks = await builderAsks(site, key);
    if (!asks.length) return { lines: ['no asks yet'] };
    const waiting = asks.filter((a) => !a.answer);
    const lines = asks.flatMap((a) => [`${a.id}. ${a.text}`, `  ${!a.answer ? 'waiting on the orchestrator' : `${a.deferred ? 'deferred' : 'answered'}: ${a.answer.text}`}`]);
    if (!wait || !waiting.length) return { lines };
    const reply = await builderReply(site, key, {});
    if (reply.length) return { lines: [...lines, ...reply] };
    if (now() >= deadline) fail(`${waiting.map((a) => a.id).join(', ')} still waiting on the orchestrator after ${minutes} minutes; run builder asks ${key} --wait again`);
    // poll: builder-asks-wait
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

// A question naming a builder's ask ("ask": "ask<n>") is that deferred ask put to the owner.
export async function checkAskQuestion(site, q, name) {
  const key = q.topic.startsWith('item:') && !q.topic.startsWith('item:ask:') ? q.topic.slice(5) : fail(`${name}.ask goes on a task's question, topic item:<file>/<id>`);
  const ask = (await builderAsks(site, key)).find((a) => a.id === q.ask) || fail(`${name}.ask names no ask "${q.ask}" on ${key}; builder asks ${key} lists them`);
  if (!ask.deferred) fail(`${name}.ask names ${ask.id}, which the orchestrator ${ask.answer ? 'answered' : 'has not deferred'}; only a deferred ask goes to the owner`);
}

// → {lines}: each call numbered, then whether the session verified them.
export async function listCalls(site, key, { dir, agent = 'main' }) {
  const record = await readJSON(await builderFile(site, key, dir, agent), null);
  const calls = record?.calls || [];
  if (!calls.length) return { lines: ['no judgment calls recorded'] };
  const { verified } = record;
  const state = !unverifiedCalls(record).length ? `verified ${verified.at}${verified.note ? `: ${verified.note}` : ''}` : 'not verified yet';
  return { lines: [...calls.map((c, i) => `${i + 1}. ${c.text}`), state] };
}

// The session's review puts each deferred ask to the owner before it marks the calls verified. A build handed back with
// no calls is marked too, as builder done with none finishes: that is the way back for one whose verification was lost.
export async function verifyCalls(site, key, { dir, agent = 'main', note }) {
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  const noCallsBack = Boolean(record?.done && record.handed_back) && !record.calls?.length;
  if (!unverifiedCalls(record).length && !noCallsBack) fail(`${key} has no unverified judgment calls${agent === 'main' ? '' : ` from agent ${agent}`}; builder calls ${key} lists them`);
  if (site) {
    const put = new Set((await readJSON(ownerFile(site), { items: [] })).items?.filter((q) => q.topic === `item:${key}` && q.ask).map((q) => q.ask));
    const owed = (await builderAsks(site, key)).find((a) => a.deferred && a.agent === agent && !put.has(a.id));
    if (owed) fail(`${owed.id} on ${key} was deferred to the owner; add its question with "ask": "${owed.id}" first`);
  }
  await writeJSON(file, { ...record, verified: { at: new Date().toISOString(), ...(note === undefined ? {} : { note: text(note, '--note') }) } });
  return file;
}

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// What a headless builder's brief is built from: {key, ref, title, notes: the notes file's path or null, worktree: the
// newest record's worktree path or null, answers: the owner's answer to each deferred ask put to them, [{ask, question,
// answer}], links: its cardLinks, prototype: its kept prototype answer, gates.prototype, or null}.
export async function briefFacts(site, key) {
  const { source, item } = await loadItem(site, key);
  const said = (q, a) => [(q.options || []).find((o) => o.id === a.choice)?.label, a.note].filter(Boolean).join(': ') || 'answered';
  const answers = (await cardQuestions(site, key)).asked.filter((q) => q.ask && q.answers.length).map((q) => ({ ask: q.ask, question: q.question, answer: said(q, q.answers.at(-1)) }));
  return { key, ref: await cardName(site, key), title: item.title || key, notes: item.plan ? path.join(source.dir, item.plan) : null, thread: threadFile(site, key), worktree: (await recordedWorktree(site, key))?.path ?? null, answers, links: await cardLinks(site, key),
    rebasePR: item.rebase_run?.pr ?? null, prototype: item.gates?.prototype ?? null };
}

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
// The cards on the board that card key links: its Parent, the cards it depends on, and the cards it is Related to
// (set on either card), in that order. → [{relation: parent|depends on|related, ref, title, status, notes: the notes
// file's path or null, thread: the thread file's path}]; a link to a card no longer on the board is left out.
async function cardLinks(site, key) {
  const cards = new Map();
  for (const entry of await itemSources(site)) {
    for (const it of (await readJSON(entry.file, null))?.items || []) cards.set(`${entry.slug}/${it.id}`, { entry, it });
  }
  const slug = parseKey(key).file;
  const { it: item } = cards.get(key);
  const back = [...cards].filter(([, c]) => (c.it.related || []).some((r) => depKey(c.entry.slug, r) === key)).map(([k]) => k);
  const linked = [
    ...(item.parent ? [['parent', depKey(slug, item.parent)]] : []),
    ...(item.deps || []).map((d) => ['depends on', depKey(slug, d)]),
    ...[...new Set([...(item.related || []).map((r) => depKey(slug, r)), ...back])].map((k) => ['related', k]),
  ].filter(([, k]) => cards.has(k));
  return Promise.all(linked.map(async ([relation, k]) => {
    const { entry, it } = cards.get(k);
    return { relation, ref: await cardName(site, k), title: it.title || k, lane: LANES[it.lane || 'todo'], notes: it.plan ? path.join(entry.dir, it.plan) : null, thread: threadFile(site, k) };
  }));
}

// docs/adr/2026-11-14-0031-a-land-step-reads-landables-skips.md
// The cards whose verified build waits to land: handed back (domain.mjs handedBackAt), every call on their records
// verified. A lander lands one with no skip; skip says why one gets none (domain.mjs landStep reads it as the card's
// step): {step: 'worktree-gone'}, else {step: 'asking'} while a question on it is open. What blocks the card, and
// whether it has finished, are the built card's (domain.mjs landSkipOf, finished): the snapshot reader calls this
// before any card is built (snapshot.mjs readSnapshot), so its callers apply them.
// → [{key, verified, kind, model, skip}], verified the newest verification's time, and kind and model the newest
// record's, so the lander runs as the agent that built the card.
export async function landable(site) {
  const out = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter(Boolean);
      if (!handedBackAt(records)) continue;
      const verified = records.map((r) => r.verified?.at).filter(Boolean).sort().at(-1);
      if (!verified || records.some((r) => unverifiedCalls(r).length)) continue;
      const key = `${source.slug}/${item.id}`;
      const builds = records.filter((r) => r.kind !== HELPER).sort((a, b) => String(b.started).localeCompare(String(a.started)));
      const newest = builds.find((r) => r.worktree?.path);
      const skip = !newest || !existsSync(newest.worktree.path) ? { step: 'worktree-gone' }
        : (await cardQuestions(site, key)).asked.some((q) => q.state === 'open') ? { step: 'asking' } : null;
      const built = newest ?? builds[0];
      out.push({ key, verified, kind: providerOf(built?.kind), model: built?.model, skip });
    }
  }
  return out;
}

// docs/adr/2026-11-17-0519-a-land-failing-on-mains-own-test-blocks-on-mains-fix.md
// The land of card key failed on test files that fail on base too (worktree.mjs passTests failsOnBase), log its full
// output: the card waits on main's fix, an open card whose title names one of the files, by its path or its name less
// .mjs, else an ask filed for it, related to the card. Blocked by it, the card takes no slot (domain.mjs pullOf). Its
// build is handed back and verified, restamped so the land after the block is a lander's first (landStep), and its
// lander lands it once the fix is done. → {said, lines}
export async function waitOnMainFix(site, key, { files, log, base }) {
  const { file: slug } = parseKey(key);
  const names = files.flatMap((f) => [f, path.posix.basename(f).replace(/\.mjs$/, '')]);
  let fix = null;
  const open = await openKeys(site);
  for (const s of await itemSources(site)) {
    for (const it of (await readJSON(s.file, null))?.items || []) {
      if (!fix && `${s.slug}/${it.id}` !== key && open.has(`${s.slug}/${it.id}`) && names.some((n) => String(it.title || '').includes(n))) fix = `${s.slug}/${it.id}`;
    }
  }
  const ref = await cardName(site, key);
  const lines = [];
  if (fix) {
    const { item } = await loadItem(site, key);
    const deps = depCards(slug, item.deps);
    if (!deps.includes(fix)) lines.push(...(await setItem(site, key, { deps: [...deps, fix].map((d) => (parseKey(d).file === slug ? parseKey(d).id : d)).join(',') })).lines);
  } else {
    fix = (await askItem(site, slug, { text: `${base} fails ${files.join(', ')}, so ${ref}'s verified land waits on its fix. Make ${files.length === 1 ? 'it' : 'them'} pass on ${base} again.${log ? ` Full test output: ${log}` : ''}`, relate: key, before: key })).key;
  }
  await setItem(site, key, { handBack: true });
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  if (record) await writeJSON(file, { ...record, verified: { ...record.verified, at: new Date().toISOString() } });
  const card = await cardName(site, fix);
  await appendStatus(site, key, 'land-held-on-base', { card, files: files.join(', ') });
  return { said: `not landed: ${files.join(', ')} fail on ${base} too, so it is blocked by ${card}, main's fix, and lands once that is done`, lines };
}

// A card whose lander stopped partway (its process gone) keeps the lander's record open, the verification on it
// (startBuilder); this closes that record as handed back, so landable finds the card again and the board server's
// land step for it (domain.mjs landStep) relaunches or faults it, counting from its data/landers.json entry
// (runs.mjs).
export async function relaunchLander(site, key) {
  releaseLaunch(site, key);
  await setItem(site, key, { handBack: true });
}

// Whether any agent record on the card is open (started, not done).
export async function hasOpenRecord(site, key) {
  const { source, item } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)));
  return records.some((r) => r?.started && !r.done);
}

// land's check: refuses while a builder record on the card holds unverified calls, naming the commands per agent.
export async function checkCallsVerified(site, key, { dir } = {}) {
  const { id } = parseKey(key);
  const files = await builderFiles(path.dirname(path.dirname(await builderFile(site, key, dir))), id);
  const owing = [];
  for (const file of files) {
    if (!unverifiedCalls(await readJSON(file, null)).length) continue;
    const agent = path.basename(file, '.json').slice(String(id).length + 1) || 'main';
    owing.push(agent === 'main' ? '' : ` --agent ${agent}`);
  }
  if (!owing.length) return;
  fail(`land: ${key} has judgment calls nobody verified yet; check them with ${owing.map((a) => `builder calls ${key}${a}`).join(', ')}, then run ${owing.map((a) => `builder verified ${key}${a}`).join(', ')}`);
}

// docs/adr/2026-11-16-0830-a-builder-hands-back-with-a-summary-message.md
// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md: builder done refuses while
// processes the build started still run detached in its worktree, naming them. find: detached.mjs detachedIn.
export async function refuseDetached(site, key, { agent = 'main' }, find) {
  const record = await readJSON(await builderFile(site, key, undefined, agent), null);
  if (!record?.started || record.done || !record.worktree?.path) return;
  const left = find(record.worktree.path, Date.parse(record.started));
  if (!left.length) return;
  fail(`builder done refuses while ${key}'s build leaves processes running detached: ${left.map((p) => `${p.pid} ${p.command}`).join('; ')}. `
    + `Stop them (kill ${left.map((p) => p.pid).join(' ')}) and run builder done again.`);
}

// `builder done --summary`: the done that ends a build, the main record of a build (no lander, rebase run, planner or
// install) handing back its judgment calls or finishing the worktree it keeps, owes a summary of what
// it built, which its record keeps and the thread shows as the Builder's message above its judgment calls (domain.mjs
// threadOf). Any other done refuses one.
export async function recordSummary(site, key, summary, { agent = 'main', next }) {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  const owed = agent === 'main' && next === undefined && record?.started && !record.done && ![LANDER, REBASE_LABEL].includes(record.label) && !plans(record) && record.kind !== 'install'
    && (unverifiedCalls(record).length > 0 || Boolean(record.worktree?.path));
  if (!owed) {
    if (summary !== undefined) fail("--summary goes on the build's own done, the one that hands back its calls or finishes its worktree");
    return;
  }
  const words = typeof summary === 'string' ? summary.trim() : '';
  if (!words) fail(`builder done ends ${key}'s build: pass --summary "${SUMMARY_HINT}"`);
  await writeJSON(file, { ...record, summary: words });
}

// `builder done`'s hand-back for a record with unverified calls: its records close as handed back with the Next the calls ask
// for, a question first (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
// → {lines}, or null when the record has none.
export async function handBackCalls(site, key, { dir, agent = 'main', next }) {
  const record = await readJSON(await builderFile(site, key, dir, agent), null);
  const calls = record && !record.done ? unverifiedCalls(record) : [];
  if (!calls.length) return null;
  if (next !== undefined) fail(`builder done sets ${key}'s Next itself while its record has judgment calls; run it without --next`);
  const asks = calls.some((c) => c.text.startsWith('Question:')) ? "Answer the builder's questions" : "Verify the builder's judgment calls";
  const set = await setItem(site, key, { handBack: true, next: asks });
  return { lines: [`handed back: Next "${asks}"`, ...set.lines] };
}

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
// Whether `builder done` from agent finishes the card (board.mjs finishCard): the main build's open record that keeps a
// worktree. Refuses while another agent's record on the card is open, other than an install build, since finishing
// closes every record.
export async function finishesCard(site, key, { agent = 'main' }) {
  if (agent !== 'main') return false;
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  if (!record?.started || record.done || !record.worktree?.path) return false;
  const { id } = parseKey(key);
  for (const other of await builderFiles(path.dirname(path.dirname(file)), id)) {
    const r = other === file ? null : await readJSON(other, null);
    if (!r?.started || r.done || r.kind === 'install') continue;
    const name = path.basename(other, '.json').slice(String(id).length + 1);
    fail(`builder done would finish ${key} while agent ${name} is still open; run builder done ${key} --agent ${name} first`);
  }
  return true;
}

// What `builder verified` does next: null when the card is closed; {held: why} when it isn't a handed-back build whose
// every call is now verified (handed back and not done, no builder open, its main build's worktree still there); else
// {waits: [question id]} while the card's questions are open, or {} when verifying finishes it.
export async function verifiedFinish(site, key) {
  const { source, item } = await loadItem(site, key);
  if ((await shownCard(site, key)).finished) return null;
  const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter(Boolean);
  if (!handedBackAt(records)) return { held: "the build hasn't handed back; run builder done first" };
  if (records.some((r) => unverifiedCalls(r).length)) return { held: 'a builder record still has unverified judgment calls' };
  if (records.some((r) => r.started && !r.done && r.kind !== 'install')) return { held: 'a builder record is still open' };
  const tree = await recordedWorktree(site, key);
  if (!tree || !existsSync(tree.path)) return { held: "the build's worktree is gone" };
  return { waits: (await cardQuestions(site, key)).asked.filter((q) => q.state === 'open').map((q) => q.id) };
}

// docs/adr/2026-11-18-2359-a-done-card-stays-done-when-commented-and-only-reopen-moves-it-back.md: a card the owner
// reopened closes again only on the owner's Done.
export async function checkNotReopened(site, key) {
  const { item } = await loadItem(site, key);
  if (item.reopened_at) fail(`the owner reopened ${await cardName(site, key)}; it closes on the owner's Done`);
}

// A card's live records: its past runs' (keepPastRun) are read by the thread alone.
export async function builderFiles(fileDir, id) {
  const dir = path.join(fileDir, 'agents');
  return (await fs.readdir(dir).catch(() => []))
    .filter((n) => n === `${id}.json` || (n.startsWith(`${id}@`) && !n.startsWith(`${id}@past-`) && n.endsWith('.json')))
    .map((n) => path.join(dir, n));
}

// Closes the card's open builder records, an install build only with the card finished. handedBack marks each record it
// closes as handed back at that time (domain.mjs handedBackAt); endHandBack takes the mark off every record, so the
// hand-back ends. held marks each started record it closes hold_stopped, for the Unblock that relaunches it (takeHoldStopped),
// and leaves open a build a pause rides on (requestPause).
export async function closeBuilders(fileDir, id, cardFinished, { handedBack, endHandBack = false, held = false } = {}) {
  const now = new Date().toISOString();
  for (const file of await builderFiles(fileDir, id)) {
    const record = await readJSON(file, null);
    if (!record) continue;
    if (record.done || (record.kind === 'install' && !cardFinished)) {
      if (endHandBack && record.handed_back) { const { handed_back, ...rest } = record; await writeJSON(file, rest); }
      continue;
    }
    if (held && record.pause) continue;
    const { eta, handed_back, ...rest } = record;
    await writeJSON(file, { ...rest, done: now, ...(handedBack ? { handed_back: handedBack } : {}), ...(held && record.started ? { hold_stopped: true } : {}) });
  }
}

// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md
// The run a Block stopped on the card's main record, taken off it for the Unblock that relaunches it: → {kind, label,
// brief}, brief a planner's briefs entry (startPlanner) or null, or null when the hold stopped none.
export async function takeHoldStopped(site, key) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  if (!record?.hold_stopped) return null;
  const { hold_stopped, ...rest } = record;
  await writeJSON(file, rest);
  return { kind: record.kind ?? null, label: record.label ?? null, brief: record.brief ?? null };
}

// Closes an agent's builder record (runs.mjs stop without kill, and finish, reach it from outside this module). The
// record stays, marked done, so the item's thread can show when the agent finished (domain.mjs threadOf).
// startedBetween [from, to] (ms) leaves a record alone unless it started in that window, so a caller closing an
// agent's own record never closes one a later agent restarted on the same item. next sets the item's Next. requireNext,
// for `builder done`, refuses closing the last open record of a card that would then sit In Progress with no Next
// (docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md); the SubagentStop hook and a board's
// close stop records whatever the card is left with.
export async function closeRecord(site, key, { dir, agent, startedBetween, note, next, requireNext = false }) {
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record || record.done) return file;
  if (startedBetween) {
    const started = Date.parse(record.started);
    if (!(started >= startedBetween[0] && started <= startedBetween[1])) return file;
  }
  const { eta, ...rest } = record;
  const done = new Date().toISOString();
  const stopped = { ...rest, done, ...(note ? { note } : {}) };
  const { id } = parseKey(key);
  const fileDir = path.dirname(path.dirname(file));
  const records = await Promise.all((await builderFiles(fileDir, id)).map((f) => (f === file ? stopped : readJSON(f, null))));
  const last = !records.some((r) => r?.started && !r.done);
  const source = dir ? { file: path.join(fileDir, 'wave.json') } : (await loadItem(site, key)).source;
  const itemFile = await readJSON(source.file, null);
  const item = itemFile?.items?.find((it) => it.id === id);
  if (next !== undefined) {
    setNext(item || fail(`${key} has no item to set --next on`), next, await hasOpenQuestion(site, key));
    if (site) await checkNextDeps(site, key, item, item.next);
  }
  if (requireNext && item && owesNext(item, records)) {
    fail(`builder done closes ${key}'s last open builder, which leaves it In Progress with no Next; pass --next "<what happens next>", or record a judgment call with builder call ${key} or land`);
  }
  await writeJSON(file, stopped);
  if (site) releaseLaunch(site, key, agent);
  await publishStaged(site, key, { screen: record.kind === 'grill' });
  if (next !== undefined) await writeJSON(source.file, itemFile);
  return file;
}

// A planner's `builder done`: closeRecord, then, if the card is still in the planner's phase with no question open,
// staged or screening for it, a fault line (domain.mjs orchestratorWaitOf reads it as a wait). A grill that ended on
// its Implement ask (asksImplement), or on a card that keeps its prototype answer (gates.prototype), may have nothing to
// ask: that card moves on instead (moveOnAnswered).
// → {file, lines}
export async function stopPlanner(site, key, flags) {
  const record = await readJSON(await builderFile(site, key, undefined, flags.agent), null);
  const kind = record?.kind;
  const file = await closeRecord(site, key, flags);
  // docs/adr/2026-11-14-2015-a-clean-visual-end-with-no-page-reads-unplaced.md: a visual agent's page is a visual thread line since its record started.
  if (kind === VISUAL) {
    if (!record.started || record.done) return { file, lines: [] };
    const placed = (await readLog(threadFile(site, key))).some((m) => m.kind === VISUAL && String(m.ts) >= record.started);
    if (placed) return { file, lines: [] };
    const { line, lines } = await appendStatus(site, key, 'visual-unplaced', {});
    return { file, lines: [line.text, ...lines] };
  }
  const { item } = await loadItem(site, key);
  const { phase, gates } = item;
  const asked = await hasOpenQuestion(site, key) || Boolean((await readJSON(stagedFile(site), {}))[key]);
  if (phase !== { grill: 'grilling', prototype: 'prototyping' }[kind] || asked) return { file, lines: [] };
  if (kind === 'grill' && (gates?.prototype || asksImplement(item)) && await moveOnAnswered(site, key)) return { file, lines: [] };
  const { line, lines } = await appendStatus(site, key, 'planner-unasked', { kind });
  return { file, lines: [line.text, ...lines] };
}

// docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md
// Each open planner record (grill, prototype, visual) of a process the board launched, which alive(record) says is gone,
// closes now. failure(record) is the words its run failed with, or null for a clean end: a failure closes as
// planner-failed (abandonPlanner); a clean grill, prototype or visual as `builder done` closes it (stopPlanner, so
// planner-unasked when no question came, visual-unplaced when no page did). A run the usage limit stopped, which
// limited(record) says with the limit's reset (else null), closes with no line, for the server to relaunch after the
// reset. → [{key, kind, failed, limited?: {until, brief}}]
export async function closeGonePlanners(site, { alive, failure, limited = () => null }) {
  const closed = [];
  for (const source of await itemSources(site)) {
    // Only the records of the cards the board builds with theirs: a Done card's are finished, and an archived card's
    // (gone from the item file) were finished before it was archived.
    const items = (await readJSON(source.file, null))?.items;
    const open = new Set(Array.isArray(items) ? items.filter((it) => it.lane !== 'done').map((it) => it.id) : []);
    const files = (await fs.readdir(path.join(source.dir, 'agents')).catch(() => []))
      .filter((n) => n.endsWith('.json') && !n.includes('@past-') && open.has(n.slice(0, -'.json'.length).split('@')[0]));
    for (const name of files) {
      const [id, ...named] = name.slice(0, -'.json'.length).split('@');
      const file = path.join(source.dir, 'agents', name);
      const record = await readJSON(file, null);
      if (!record?.started || record.done || !plans(record) || !record.session?.pid || alive(record)) continue;
      const key = `${source.slug}/${id}`;
      const agent = named.join('@') || 'main';
      const until = limited(record);
      if (until) {
        await closeRecord(site, key, { agent });
        closed.push({ key, kind: record.kind, failed: null, limited: { until, brief: record.brief ?? null } });
        continue;
      }
      const failed = failure(record);
      if (failed) await abandonPlanner(site, key, ['planner-failed', { kind: record.kind === VISUAL ? 'visual agent' : record.kind, error: failed }], agent);
      else await stopPlanner(site, key, { agent });
      closed.push({ key, kind: record.kind, failed });
    }
  }
  return closed;
}

export async function openBoardBuilders(site) {
  const builders = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      for (const file of await builderFiles(source.dir, item.id)) {
        const record = await readJSON(file, null);
        if (!record?.started || record.done) continue;
        const name = path.basename(file, '.json');
        builders.push({ key: `${source.slug}/${item.id}`, agent: name.slice(String(item.id).length + 1) || 'main', label: record.label || 'Builder', started: record.started, kind: record.kind ?? null, pid: record.session?.pid ?? null });
      }
    }
  }
  return builders;
}
