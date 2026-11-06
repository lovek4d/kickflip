#!/usr/bin/env node
// The pause line's hook (docs/adr/2026-11-01-1710-work-pauses-at-the-pause-line.md): SessionStart and UserPromptSubmit
// say paused or Keep going, and PreToolUse denies new agents while paused. A board's session also reads its board's own
// pause, the board being the manifest site its session owns
// (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsageGate, pauseReason } from '../../shared/usage-gate.mjs';

function boardDirOf(session) {
  try {
    const sites = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'kickflip', 'manifest.json'), 'utf8')).sites || {};
    return Object.values(sites).find((s) => s?.owner?.session === session)?.dir ?? null;
  } catch { return null; }
}

const MANUAL = { hub: 'The owner paused the hub', board: 'The owner paused this board' };
process.stdout.on('error', () => {});
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const gate = readUsageGate({ dir: input.session_id ? boardDirOf(input.session_id) : null });
  if (input.hook_event_name === 'PreToolUse') {
    if (gate.state === 'paused' && ['Agent', 'Task'].includes(input.tool_name)) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: pauseReason(gate),
    } }));
  } else if (['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name)) {
    const why = gate.manual ? MANUAL[gate.manual] : `Claude's usage is past the pause line (${gate.pause_at}%)`;
    if (gate.state === 'paused') console.log(`${why}. Running steps finish; start no new work, builders or agents until ${gate.resets_at}; answer the owner's messages briefly with "paused until <that time, in the owner's local time>".`);
    else if (gate.state === 'going') console.log(`Keep going is on: work runs past the pause line until ${gate.resets_at}, spending usage.`);
  }
} catch {}
process.exitCode = 0;
