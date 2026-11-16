import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./waits-filter-gate.mjs', import.meta.url));
const run = (command, tool_name = 'Bash', hook_event_name = 'PreToolUse') => {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name, tool_name, tool_input: { command } }), encoding: 'utf8' });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};

test('a command that can drop waits lines from a wait-events output file is denied, naming rg \'^waits\'', () => {
  for (const command of [
    "rg '^waits' $O | rg -v 'T-355|T-367'",
    "rg '^waits' $O | grep -v '#8(1|2)'",
    "rg '^waits' $O | head -5",
    "rg '^waits' /tmp/tasks/abc.output | tail -3",
    "cat $O | rg -v 'already shown'",
    "rg -v '^event' /tmp/tasks/abc.output",
    "rg T-373 $O",
    "tail -20 $O",
    "head -50 /tmp/claude/tasks/x.output",
    "awk '!/T-355/' $O",
    "sed '/T-355/d' $O",
    "rg '^waits' $O | rg 'calls'",
    "echo hi; rg '^waits' $O | sed -n 1,3p",
  ]) {
    const o = run(command);
    assert.equal(o?.permissionDecision, 'deny', command);
    assert.match(o.permissionDecisionReason, /rg '\^waits'/);
  }
});

test('reading waits whole, selecting events, cutting columns and unrelated commands pass', () => {
  for (const command of [
    "rg '^waits' $O",
    "rg '^waits' $O | cut -c1-150",
    "rg '^event' $O | rg -v 'already shown'",
    "rg '^event' $O | head -3",
    "cat $O | rg '^event' | tail -2",
    "rg -v foo src/file.txt | head",
    "git log | head -5",
    "ls | tail -1",
    // Reading the watcher's source is no read of its output.
    'sed -n 1,20p bin/wait-events.mjs',
    'head -40 bin/wait-events.test.mjs',
    "rg -n 'added' bin/wait-events.mjs | head",
  ]) assert.equal(run(command), null, command);
  assert.equal(run("rg -v x $O", 'Read'), null);
  assert.equal(run("rg -v x $O", 'Bash', 'PostToolUse'), null);
});
