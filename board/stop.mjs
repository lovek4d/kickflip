// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The orchestrator's stops of the runs the board launched on a card, so its session never needs a raw kill: `builder
// stop` stops the card's headless builder, lander or rebase run, `item stall` stops it and flags the card stalled, and
// `land stop` the card's land, with every process
// under each, a land's detached suite too (headless.mjs stopRuns). Each marks the card so nothing relaunches the run,
// writes the stop's words (domain.mjs stoppedWords) as a thread line, and says what it stopped. A bump moves the card's
// queued lands first (worktree.mjs moveQueuedLand). Each stop takes runner {ps, grace}: the ps that reads the process
// table (live.mjs ps by default) and the grace headless.mjs stopRuns gives a stopped process before SIGKILL.
import * as store from './store.mjs';
import { launchedAgents, stopRuns } from './headless.mjs';
import { clearStoppedLand, landLock, landQueue, moveQueuedLand, runningLand } from './worktree.mjs';
import { orchestratorDid, plans, stoppedWords } from './domain.mjs';
import { processStarts, ps as livePs } from '../hub/live.mjs';

const fail = (msg) => { throw new store.BoardError(msg); };
const ARGS_CAP = 120;
const pidLines = (stopped) => stopped.map((p) => `stopped ${p.pid} ${p.args.length > ARGS_CAP ? `${p.args.slice(0, ARGS_CAP - 1)}…` : p.args}`);
const stoppedLines = (ref, run, stopped) => [`${ref}: ${stoppedWords(run)}`, ...pidLines(stopped)];

const startsBy = ({ ps }) => (pids) => processStarts(pids, { ps });

async function stopped(site, key, run, leader, runner) {
  await store.markStopped(site, key, run);
  const processes = await stopRuns([leader], runner);
  await store.appendStatus(site, key, 'run-stopped', { words: stoppedWords(run) });
  return processes;
}

// The card's running build the board launched: {pid, at} of its agent, refusing a planner, a session's own builder or
// none.
async function launchedBuild(site, key, ref, runner) {
  const runs = await store.openRuns(site, key);
  const builds = runs.filter((r) => !plans(r));
  if (!builds.length && runs.length) fail(`${ref} has a ${runs[0].kind} planner running, not a build; builder stop stops builds, landers and rebase runs`);
  if (builds.length && builds.every((r) => !r.pid)) fail(`${ref}'s builder wasn't launched by the board, so it isn't the board's to stop; stop it in its own session`);
  return launchedAgents(builds, { starts: startsBy(runner) })[0] ?? fail(`${ref}'s builder isn't running`);
}

async function stopAgent(site, key, ref, agent, runner) {
  const run = await store.isLanding(site, key) ? 'land' : 'build';
  const processes = await stopped(site, key, run, agent.pid, runner);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return stoppedLines(ref, run, processes);
}

export async function stopBuilder(site, key, runner = {}) {
  const ref = await store.cardName(site, key);
  return { lines: await stopAgent(site, key, ref, await launchedBuild(site, key, ref, runner), runner) };
}

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md,
// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// The pull's bump-out of the card at key for bumped card by, past the cap: its build pauses at its next stopping point
// and the card stays In Progress (store.mjs requestPause), resuming ahead of the pull once a slot frees. pullOf's
// bumpOuts names only a card whose one run the board launched. → its lines
export async function bumpOut(site, key, by) {
  const words = `bumped out by ${await store.cardName(site, by)}`;
  await store.requestPause(site, key, { cause: 'bumped', words, by });
  return [`${await store.cardName(site, key)} pauses: ${words}`];
}

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
// The orchestrator's stall of a card it can't restart (item stall): the card is flagged with the reason, each open build
// record is marked stopped so nothing relaunches it and its slot frees, and its board-launched run stops as builder stop
// stops it. A run already gone, or one a session runs, has nothing the board can stop. Its worktree stays. → its lines
export async function stallCard(site, key, reason, runner = {}) {
  const ref = await store.cardName(site, key);
  const words = await store.markStalled(site, key, reason);
  await store.markStopped(site, key, await store.isLanding(site, key) ? 'land' : 'build');
  const agent = launchedAgents((await store.openRuns(site, key)).filter((r) => !plans(r)), { starts: startsBy(runner) })[0];
  const processes = agent ? await stopRuns([agent.pid], runner) : [];
  clearStoppedLand(ref, processes.map((p) => p.pid));
  await store.appendMessage(site, key, { text: `stalled by orchestrator: ${words}` });
  return { lines: [`${ref} stalled: ${words}`, ...pidLines(processes)] };
}

const pgidOf = (pid, { ps = livePs }) => Number(ps(['-o', 'pgid=', '-p', String(pid)])?.trim()) || null;

// A land run by the card's headless builder or lander stops that agent whole, since its done would otherwise be run
// again; the land a held card's Merge tap started stops alone, and the card's Merge shows again.
export async function stopLand(site, key, runner = {}) {
  const ref = await store.cardName(site, key);
  const land = runningLand(ref);
  // A pid since reused started after its marker was written.
  const started = land && startsBy(runner)([land.pid])?.get(land.pid);
  if (!land || !(started <= Date.parse(land.at) + 2000)) fail(`${ref} has no land running`);
  if (landLock()?.pid === land.pid) fail(`${ref} is fast-forwarding main now; it can't be stopped partway`);
  const group = pgidOf(land.pid, runner);
  const runs = await store.openRuns(site, key);
  const agent = launchedAgents(runs.filter((r) => !plans(r)), { starts: startsBy(runner) }).find((a) => a.pid === group);
  let processes;
  if (agent) processes = await stopped(site, key, 'land', agent.pid, runner);
  else if (land.merge && group === land.pid) {
    await store.stopHeldMerge(site, key);
    processes = await stopRuns([land.pid], runner);
    await store.appendStatus(site, key, 'run-stopped', { words: stoppedWords('land') });
  } else fail(`${ref}'s land runs in a session the board didn't launch; stop it in that session`);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return { lines: stoppedLines(ref, 'land', processes) };
}

// The orchestrator's bump (on) or unbump: the board's bump of the card, and its place in the land queue.
export async function bump(site, key, on) {
  const ref = await store.cardName(site, key);
  const at = await store.bumpCard(site, key, on);
  const moved = moveQueuedLand(site, key, on ? at : null);
  if (on && moved) await store.appendStatus(site, key, 'land-moved-first', { words: orchestratorDid('land', 'moved first') });
  return { lines: [on ? `${ref} bumped${moved ? ': its land moved first' : ''}` : `${ref} unbumped`] };
}

// The host's land queue, one line each: the land running, then the waiting ones in their order.
export function queueLines() {
  const queue = landQueue();
  if (!queue.length) return { lines: ['no land queued'] };
  const waiting = queue.filter((q) => !q.running);
  return { lines: [...queue.filter((q) => q.running).map((q) => `${q.card} landing now`), ...waiting.map((q, i) => `${i + 1}. ${q.card}${q.first ? ' (bumped)' : ''}`)] };
}
