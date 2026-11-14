import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/temp-dir.mjs';

const hook = fileURLToPath(new URL('./ask-gate.mjs', import.meta.url));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };

// docs/adr/2026-11-14-0646-a-headless-board-session-asks-on-the-board.md
test("a headless board session's AskUserQuestion and plan mode are denied with the board's way to ask; everything else passes", (t) => {
  const home = tempDir('ask-gate-');
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: { shop: { dir: path.join(home, 'shop'), owner: { session: 's1' } }, page: { dir: path.join(home, 'page') } } });
  const run = (input, jobDir = path.join(home, 'job')) => {
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_JOB_DIR;
    if (jobDir) env.CLAUDE_JOB_DIR = jobDir;
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', ...input }), env, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };

  for (const tool_name of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
    assert.deepEqual(run({ session_id: 's1', tool_name }), {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'This board session is headless, so nobody can answer a terminal prompt. Ask on the board: `question add --file`, or `reply <card> --questions`.',
    }, tool_name);
  }
  assert.equal(run({ session_id: 's1', tool_name: 'AskUserQuestion' }, null), null, 'an interactive session keeps its dialog');
  assert.equal(run({ session_id: 'other', tool_name: 'AskUserQuestion' }), null, 'a headless job that owns no board');
  assert.equal(run({ session_id: 's1', tool_name: 'Bash' }), null);
  assert.equal(run({ session_id: 's1', tool_name: 'AskUserQuestion', hook_event_name: 'PostToolUse' }), null);
  fs.rmSync(path.join(home, '.claude', 'kickflip', 'manifest.json'));
  assert.equal(run({ session_id: 's1', tool_name: 'AskUserQuestion' }), null, 'no manifest, no board');
});

test('the plugin runs the gate before the tools that wait on the owner, through the skills link', () => {
  const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./hooks.json', import.meta.url)), 'utf8'));
  assert.deepEqual(plugin.hooks.PreToolUse.find((h) => h.matcher === 'AskUserQuestion|EnterPlanMode|ExitPlanMode'),
    { matcher: 'AskUserQuestion|EnterPlanMode|ExitPlanMode', hooks: [{ type: 'command', command: 'node "$HOME/.claude/skills/kickflip/hooks-plugin/hooks/ask-gate.mjs"' }] });
});
