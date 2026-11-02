#!/usr/bin/env node
import fs from 'node:fs';
import { readUsageGate, pauseReason } from '../../shared/usage-gate.mjs';

process.stdout.on('error', () => {});
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const gate = readUsageGate();
  if (input.hook_event_name === 'PreToolUse') {
    if (gate.state === 'paused' && ['Agent', 'Task'].includes(input.tool_name)) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: pauseReason(gate),
    } }));
  } else if (['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name)) {
    if (gate.state === 'paused') console.log(`Claude's usage is past the pause line (${gate.pause_at}%). Running steps finish; start no new work, builders or agents until ${gate.resets_at}; answer the owner's messages briefly with "paused until <that time, in the owner's local time>".`);
    else if (gate.state === 'going') console.log(`Keep going is on: work runs past the pause line until ${gate.resets_at}, spending usage.`);
  }
} catch {}
process.exitCode = 0;
