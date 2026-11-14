import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const hook = fileURLToPath(new URL('./builder-guard.mjs', import.meta.url));
const worktree = path.join(os.homedir(), '.claude', 'kickflip', 'worktrees', 'T-323');
const run = (command, cwd = worktree, extra = {}) => {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command }, ...extra }), encoding: 'utf8' });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};

// docs/adr/2026-11-14-0720-a-builder-guard-refuses-push-and-broad-kills.md
test('a builder session refuses git push and broad kills', () => {
  for (const command of [
    'git push', 'git push origin main', 'git -C /x push', 'git -c core.commentChar=";" push --force',
    'cd x && git push', 'echo hi; git push', 'FOO=1 git push', 'pkill node', 'sudo pkill -f board', 'killall node',
    'kill 0', 'kill -9 -1234', 'kill -- -1234', 'ls | xargs pkill',
  ]) {
    const out = run(command);
    assert.equal(out?.permissionDecision, 'deny', command);
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.match(out.permissionDecisionReason, /builder/, command);
  }
});

test('everything else passes: commits, git add in every form, a kill of one pid, words that only mention push', () => {
  for (const command of [
    'git add -A', 'git add .', 'git add a.mjs', "git -c core.commentChar=';' commit -F msg", 'git status', 'git pull',
    'kill 1234', 'kill -9 1234', 'echo "git push"', 'rg pkill', 'git log --grep push', 'node board.mjs builder done x --text "no git push"',
  ]) assert.equal(run(command), null, command);
});

test('only a worktree builder is guarded, and only the Bash tool', () => {
  assert.equal(run('git push', path.join(os.homedir(), 'dev', 'kickflip')), null, 'the main checkout');
  assert.equal(run('git push', undefined, { tool_name: 'Edit' }), null);
  assert.equal(run('git push', worktree, { hook_event_name: 'PostToolUse' }), null);
  assert.equal(run('git push', path.join(worktree, 'hooks-plugin'))?.permissionDecision, 'deny');
});

test('the plugin runs the guard before Bash', () => {
  const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./hooks.json', import.meta.url)), 'utf8'));
  assert.deepEqual(plugin.hooks.PreToolUse.find((h) => h.matcher === 'Bash'),
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/skills/kickflip/hooks-plugin/hooks/builder-guard.mjs"' }] });
});
