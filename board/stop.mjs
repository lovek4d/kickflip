// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The orchestrator's stops of a card beyond `builder stop` (runs.mjs stop with kill), so its session never needs a raw
// kill: `item stall` stops the card's board-launched run and flags the card stalled, and `land stop` stops the card's
// land, with every process under each, a land's detached suite too (headless.mjs stopRuns). Each marks the card so
// nothing relaunches the run, writes the stop's words (domain.mjs stoppedWords) as a thread line, and says what it
// stopped. A bump moves the card's queued lands first (worktree.mjs moveQueuedLand). Each stop takes runner {ps, grace}:
// the ps that reads the process table (live.mjs ps by default) and the grace headless.mjs stopRuns gives a stopped
// process before SIGKILL.
import { BoardError } from './checks.mjs';
import { cardName, appendMessage, appendStatus } from './cards.mjs';
import { stopRuns } from './headless.mjs';
import { bumpCard, isLanding, launchedBuilds, markStalled, markStopped, pidLines, startsBy, stopHeldMerge, stoppedLines, stopProcess } from './runs.mjs';
import { clearStoppedLand, landLock, landQueue, moveQueuedLand, runningLand } from './worktree.mjs';
import { orchestratorDid, stoppedWords } from './domain.mjs';
import { ps as livePs } from '../hub/live.mjs';

const fail = (msg) => { throw new BoardError(msg); };

// A stall reason that names something to wait for (a quiet host, a landing task) is a block until a condition.
const WAIT_CONDITION = /\bwaiting\b|\bwait(s)? (for|until|on)\b|\buntil\b|\bonce (the|it|a|all|they|its)\b/i;

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
// The orchestrator's stall of a card it can't restart (item stall): the card is flagged with the reason, each open build
// record is marked stopped so nothing relaunches it (the card keeps its slot), and its board-launched run stops as builder stop
// (runs.mjs stop) stops it. A run already gone, or one a session runs, has nothing the board can stop. Its worktree stays. → its lines
export async function stallCard(site, key, reason, runner = {}) {
  const ref = await cardName(site, key);
  if (WAIT_CONDITION.test(reason ?? '')) fail(`${ref}: "${reason}" is a wait for a condition, which waits on nobody: use item set ${ref} --blocked-until "<condition>". stall is for a stuck task you can't restart`);
  const words = await markStalled(site, key, reason);
  await markStopped(site, key, await isLanding(site, key) ? 'land' : 'build');
  const agent = (await launchedBuilds(site, key, runner))[0];
  const processes = agent ? await stopRuns([agent.pid], runner) : [];
  clearStoppedLand(ref, processes.map((p) => p.pid));
  await appendMessage(site, key, { text: `stalled by orchestrator: ${words}` });
  return { lines: [`${ref} stalled: ${words}`, ...pidLines(processes)] };
}

const pgidOf = (pid, { ps = livePs }) => Number(ps(['-o', 'pgid=', '-p', String(pid)])?.trim()) || null;

// A land run by the card's headless builder or lander stops that agent whole, since its done would otherwise be run
// again; the land a held card's Merge tap started stops alone, and the card's Merge shows again.
export async function stopLand(site, key, runner = {}) {
  const ref = await cardName(site, key);
  const land = runningLand(ref);
  // A pid since reused started after its marker was written.
  const started = land && startsBy(runner)([land.pid])?.get(land.pid);
  if (!land || !(started <= Date.parse(land.at) + 2000)) fail(`${ref} has no land running`);
  if (landLock()?.pid === land.pid) fail(`${ref} is fast-forwarding main now; it can't be stopped partway`);
  const group = pgidOf(land.pid, runner);
  const agent = (await launchedBuilds(site, key, runner)).find((a) => a.pid === group);
  let processes;
  if (agent) processes = await stopProcess(site, key, 'land', agent.pid, runner);
  else if (land.merge && group === land.pid) {
    await stopHeldMerge(site, key);
    processes = await stopRuns([land.pid], runner);
    await appendStatus(site, key, 'run-stopped', { words: stoppedWords('land') });
  } else fail(`${ref}'s land runs in a session the board didn't launch; stop it in that session`);
  clearStoppedLand(ref, processes.map((p) => p.pid));
  return { lines: stoppedLines(ref, 'land', processes) };
}

// The orchestrator's bump (on) or unbump: the board's bump of the card, and its place in the land queue.
export async function bump(site, key, on) {
  const ref = await cardName(site, key);
  const at = await bumpCard(site, key, on);
  const moved = moveQueuedLand(site, key, on ? at : null);
  if (on && moved) await appendStatus(site, key, 'land-moved-first', { words: orchestratorDid('land', 'moved first') });
  return { lines: [on ? `${ref} bumped${moved ? ': its land moved first' : ''}` : `${ref} unbumped`] };
}

// The host's land queue, one line each: the land running, then the waiting ones in their order.
export function queueLines() {
  const queue = landQueue();
  if (!queue.length) return { lines: ['no land queued'] };
  const waiting = queue.filter((q) => !q.running);
  return { lines: [...queue.filter((q) => q.running).map((q) => `${q.card} landing now`), ...waiting.map((q, i) => `${i + 1}. ${q.card}${q.first ? ' (bumped)' : ''}`)] };
}
