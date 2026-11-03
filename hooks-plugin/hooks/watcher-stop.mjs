#!/usr/bin/env node
// A Claude Code Stop hook for a session that owns a board in the manifest. It blocks the turn from ending while that
// board has no live watcher, naming the command that relaunches it, or while a message there reads Working on it with
// no answer, naming each (its board server's /api/working). Claude Code sets stop_hook_active while a Stop hook keeps
// the turn going, so it blocks at most once a turn and a session whose Bash is broken can't loop. Any error lets the
// turn end (docs/adr/0131-the-cli-and-board-server-do-the-boards-housekeeping.md,
// docs/adr/0133-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md).
import fs from 'node:fs';

process.stdout.on('error', () => {});

async function workingOn(board) {
  try {
    const r = await fetch(`http://127.0.0.1:${board.port}/api/working`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).working || [] : [];
  } catch { return []; }
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'Stop' && !input.stop_hook_active && typeof input.session_id === 'string' && input.session_id) {
    const { listBoards, watcherRunning } = await import('../../hub/boards.mjs');
    const { watcherCommand } = await import('../../bin/install.mjs');
    const owned = listBoards().filter((b) => b.owner?.session === input.session_id);
    // A watcher launched as a background task this turn may not have written data/watcher.json yet. Claude Code lists
    // only in-flight tasks in background_tasks.
    const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
    const launched = (route) => tasks.some((t) => typeof t?.command === 'string'
      && new RegExp(`wait-events\\.mjs['"]?\\s+['"]?${route}['"]?\\s`).test(`${t.command} `));
    const silent = owned.filter((b) => !launched(b.route) && !watcherRunning(b.dir, Date.now(), { grace: 0 }));
    const reasons = [];
    if (silent.length) {
      const steps = silent.map((b) => `/${b.route}: ${watcherCommand(b.route, input.session_id)}`);
      reasons.push(`Your board has no watcher, so its events wait unheard. Relaunch it as a background Bash task, then end your turn: ${steps.join('; ')}`);
    }
    const owed = (await Promise.all(owned.map(async (b) => (await workingOn(b)).map((w) => `/${b.route} ${w.kind} ${w.id}${w.card ? ` on ${w.card}` : ''}`)))).flat();
    if (owed.length) reasons.push(`These read Working on it with no answer: ${owed.join('; ')}. Answer each with board.mjs reply or a thread line on its card, even a short "Looking into it" while an agent works, then end your turn.`);
    if (reasons.length) console.log(JSON.stringify({ decision: 'block', reason: reasons.join(' ') }));
  }
} catch {}
process.exitCode = 0;
