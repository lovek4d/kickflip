// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The orchestrator's stops of the runs the board launched on a card, so its session never needs a raw kill: `builder
// stop` stops the card's headless builder, lander or rebase run, and `land stop` the card's land, with every process
// under each, a land's detached suite too (headless.mjs stopRuns). Each marks the card so nothing relaunches the run,
// writes the stop's words (domain.mjs stoppedWords) as a thread line, and says what it stopped. A bump moves the card's
// queued lands first (worktree.mjs moveQueuedLand).
import { spawnSync } from 'node:child_process';
import * as store from './store.mjs';
import { launchedAgents, stopRuns } from './headless.mjs';
import { clearStoppedLand, landLock, landQueue, moveQueuedLand, runningLand } from './worktree.mjs';
import { orchestratorDid, plans, stoppedWords } from './domain.mjs';
import { processStarts } from '../hub/live.mjs';

const fail = (msg) => { throw new store.BoardError(msg); };
const ARGS_CAP = 120;
const stoppedLines = (ref, run, stopped) => [`${ref}: ${stoppedWords(run)}`, ...stopped.map((p) => `stopped ${p.pid} ${p.args.length > ARGS_CAP ? `${p.args.slice(0, ARGS_CAP - 1)}…` : p.args}`)];

async function stopped(site, key, run, leader) {
  await store.markStopped(site, key, run);
  const processes = await stopRuns([leader]);
  await store.appendThread(site, key, { text: stoppedWords(run) });
  return processes;
}

// The card's running build the board launched: {pid, at} of its agent, refusing a planner, a session's own builder or
// none.
async function launchedBuild(site, key, ref) {
  const runs = await store.openRuns(site, key);
  const builds = runs.filter((r) => !plans(r));
  if (!builds.length && runs.length) fail(`${ref} has a ${runs[0].kind} planner running, not a build; builder stop stops builds, landers and rebase runs`);
  if (builds.length && builds.every((r) => !r.pid)) fail(`${ref}'s builder wasn't launched by the board, so it isn't the board's to stop; stop it in its own session`);
  return launchedAgents(builds)[0] ?? fail(`${ref}'s builder isn't running`);
}

async function stopAgent(site, key, ref, agent) {
  const run = await store.isLanding(site, key) ? 'land' : 'build';
  const processes = await stopped(site, key, run, agent.pid);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return stoppedLines(ref, run, processes);
}

export async function stopBuilder(site, key) {
  const ref = await store.cardName(site, key);
  return { lines: await stopAgent(site, key, ref, await launchedBuild(site, key, ref)) };
}

// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md
// item set's stop of a card's open build as a block sends the card back to Todo: its board-launched builder, lander or
// rebase run stops as builder stop stops it, and one whose process is already gone has nothing to stop. A session's own
// builder is refused, since the board can't stop it. → the stop's lines
export async function stopForBlock(site, key) {
  const ref = await store.cardName(site, key);
  const builds = (await store.openRuns(site, key)).filter((r) => !plans(r));
  if (builds.every((r) => !r.pid)) fail(`${ref}'s builder runs in a session the board didn't launch, so blocking it can't stop it; finish or stop it in that session with builder done --next, then block it`);
  const agent = launchedAgents(builds)[0];
  return agent ? stopAgent(site, key, ref, agent) : [];
}

const pgidOf = (pid) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || null;

// A land run by the card's headless builder or lander stops that agent whole, since its done would otherwise be run
// again; the land a held card's Merge tap started stops alone, and the card's Merge shows again.
export async function stopLand(site, key) {
  const ref = await store.cardName(site, key);
  const land = runningLand(ref);
  // A pid since reused started after its marker was written.
  const started = land && processStarts([land.pid])?.get(land.pid);
  if (!land || !(started <= Date.parse(land.at) + 2000)) fail(`${ref} has no land running`);
  if (landLock()?.pid === land.pid) fail(`${ref} is fast-forwarding main now; it can't be stopped partway`);
  const group = pgidOf(land.pid);
  const runs = await store.openRuns(site, key);
  const agent = launchedAgents(runs.filter((r) => !plans(r))).find((a) => a.pid === group);
  let processes;
  if (agent) processes = await stopped(site, key, 'land', agent.pid);
  else if (land.merge && group === land.pid) {
    await store.stopHeldMerge(site, key);
    processes = await stopRuns([land.pid]);
    await store.appendThread(site, key, { text: stoppedWords('land') });
  } else fail(`${ref}'s land runs in a session the board didn't launch; stop it in that session`);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return { lines: stoppedLines(ref, 'land', processes) };
}

// The orchestrator's bump (on) or unbump: the board's bump of the card, and its place in the land queue.
export async function bump(site, key, on) {
  const ref = await store.cardName(site, key);
  const at = await store.bumpCard(site, key, on);
  const moved = moveQueuedLand(site, key, on ? at : null);
  if (on && moved) await store.appendThread(site, key, { text: orchestratorDid('land', 'moved first') });
  return { lines: [on ? `${ref} bumped${moved ? ': its land moved first' : ''}` : `${ref} unbumped`] };
}

// The host's land queue, one line each: the land running, then the waiting ones in their order.
export function queueLines() {
  const queue = landQueue();
  if (!queue.length) return { lines: ['no land queued'] };
  const waiting = queue.filter((q) => !q.running);
  return { lines: [...queue.filter((q) => q.running).map((q) => `${q.card} landing now`), ...waiting.map((q, i) => `${i + 1}. ${q.card}${q.first ? ' (bumped)' : ''}`)] };
}
