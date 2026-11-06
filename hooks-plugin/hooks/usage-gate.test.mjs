import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./usage-gate.mjs', import.meta.url));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test("a board's session hears its own board's pause and the hub's, and other sessions only the hub's", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gate-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.claude', 'kickflip');
  const dir = path.join(home, 'shop');
  const until = new Date(Date.now() + 3600_000).toISOString();
  write(path.join(state, 'manifest.json'), { sites: { shop: { dir, owner: { session: 's1' } } } });
  write(path.join(dir, 'board.json'), { title: 'Shop', paused_until: until });
  const run = (input) => {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }).trim(),
    `The owner paused this board. Running steps finish; start no new work, builders or agents until ${until}; answer the owner's messages briefly with "paused until <that time, in the owner's local time>".`);
  const denied = JSON.parse(run({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent' }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /the owner paused this board/);
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: 'other' }), '');
  assert.equal(run({ hook_event_name: 'PreToolUse', session_id: 'other', tool_name: 'Agent' }), '');
  write(path.join(state, 'settings.json'), { paused_until: until });
  assert.match(run({ hook_event_name: 'SessionStart', session_id: 'other' }), /^The owner paused the hub\. /);
  write(path.join(state, 'settings.json'), { paused_until: 'forever' });
  assert.equal(run({ hook_event_name: 'SessionStart', session_id: 'other' }).trim(),
    'The owner paused the hub. Running steps finish; start no new work, builders or agents until the owner resumes it; answer the owner\'s messages briefly with "paused until you resume".');
});
