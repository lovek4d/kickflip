#!/usr/bin/env node
// A PreToolUse hook on AskUserQuestion|EnterPlanMode|ExitPlanMode that refuses them in a headless board session: one
// running as a background job (CLAUDE_JOB_DIR set) whose session id is a manifest site's owner.session. Each of these
// tools waits on the person at a terminal nobody watches, so the reason sends the question to the board instead.
// Interactive sessions and background jobs that own no board pass
// (docs/adr/2026-11-14-0646-a-headless-board-session-asks-on-the-board.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

function ownsBoard(session) {
  try {
    const sites = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'kickflip', 'manifest.json'), 'utf8')).sites || {};
    return Object.values(sites).some((s) => s?.owner?.session === session);
  } catch { return false; }
}

process.stdout.on('error', () => {});
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'PreToolUse' && TOOLS.includes(input.tool_name) && process.env.CLAUDE_JOB_DIR && input.session_id && ownsBoard(input.session_id)) {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'This board session is headless, so nobody can answer a terminal prompt. Ask on the board: `question add --file`, or `reply <card> --questions`.',
    } }));
  }
} catch {}
process.exitCode = 0;
