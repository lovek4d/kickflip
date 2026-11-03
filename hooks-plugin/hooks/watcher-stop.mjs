#!/usr/bin/env node
// A Claude Code Stop hook: a session that owns a board in the manifest can't end its turn while that board has no
// live watcher (docs/adr/0131-the-cli-and-board-server-do-the-boards-housekeeping.md). It blocks with the command that
// relaunches it. Claude Code sets stop_hook_active while a Stop hook keeps the turn going, so it blocks at most once a
// turn and a session whose Bash is broken can't loop. Any error lets the turn end.
import fs from 'node:fs';

process.stdout.on('error', () => {});
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'Stop' && !input.stop_hook_active && typeof input.session_id === 'string' && input.session_id) {
    const { listBoards, watcherRunning } = await import('../../hub/boards.mjs');
    const { watcherCommand } = await import('../../bin/install.mjs');
    // A watcher launched as a background task this turn may not have written data/watcher.json yet. Claude Code lists
    // only in-flight tasks in background_tasks.
    const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
    const launched = (route) => tasks.some((t) => typeof t?.command === 'string'
      && new RegExp(`wait-events\\.mjs['"]?\\s+['"]?${route}['"]?\\s`).test(`${t.command} `));
    const silent = listBoards().filter((b) => b.owner?.session === input.session_id && !launched(b.route) && !watcherRunning(b.dir, Date.now(), { grace: 0 }));
    if (silent.length) {
      const steps = silent.map((b) => `/${b.route}: ${watcherCommand(b.route, input.session_id)}`);
      console.log(JSON.stringify({ decision: 'block', reason: `Your board has no watcher, so its events wait unheard. Relaunch it as a background Bash task, then end your turn: ${steps.join('; ')}` }));
    }
  }
} catch {}
process.exitCode = 0;
