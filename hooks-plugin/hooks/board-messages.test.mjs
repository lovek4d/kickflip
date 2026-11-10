import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./board-messages.mjs', import.meta.url));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };

// docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md
test("the PostToolUse hook shows the owner's new thread messages, asks and ask edits to the board's session once each, with their sent time and age, and marks them working", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-messages-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'kickflip', 'sites', 'orch');
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: {
    orch: { dir, port: 1, cmd: [process.execPath, '/skill/board/server.mjs', dir], owner: { session: 's1' } },
    notes: { dir: path.join(home, 'notes'), port: 1, cmd: ['node', 'server.mjs'], owner: { session: 's2' } },
  } });
  write(path.join(dir, 'board.json'), { title: 'Orch' });
  const events = path.join(dir, 'data', 'events.jsonl');
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const line = (id, kind, ts, data) => JSON.stringify({ id, kind, ts, data });
  write(events, [
    line('e0', 'item-message', ago(30), { key: 'w/A1', text: 'Already woken for' }),
    line('e1', 'item-message', ago(3), { key: 'w/A1', text: 'Use the blue' }),
    line('e2', 'card-bump', ago(2), { key: 'w/A1' }),
    line('e3', 'ask', ago(0), { text: 'A new task' }),
    line('e4', 'ask-edited', ago(0), { id: 'e3', text: 'A new task, edited' }),
  ].join('\n') + '\n');
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 1 });
  const run = (input) => {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's1', ...input }), env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };

  // A subagent's tool call carries agent_id under its parent's session_id, and another session owns no board here.
  assert.equal(run({ agent_id: 'a1' }), null);
  assert.equal(run({ session_id: 's2' }), null);
  assert.equal(run({ session_id: 's3' }), null);

  const shown = run();
  assert.equal(shown.hookEventName, 'PostToolUse');
  const lines = shown.additionalContext.split('\n');
  assert.match(lines[0], /^The owner wrote on \/orch while you worked\. Read it now: their words come before what you were doing\. Your watcher prints each again on its next wake, tagged already shown\.$/);
  assert.match(lines[1], /^sent \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z, 3 min ago: message received from A1's thread: reply in its thread$/);
  assert.match(lines[2], /^event data\/events\.jsonl \{"id":"e1","kind":"item-message".*"text":"Use the blue"/);
  assert.match(lines[3], /^sent \S+, just now: new task e3 received as task e3: /);
  assert.match(lines[5], /^sent \S+, just now: task e3 edited: use the new text, and say what changed if you had started$/);
  assert.equal(lines.length, 7);
  assert.doesNotMatch(shown.additionalContext, /card-bump|Already woken for/);
  // They read thinking on the board at once: the watcher's working marks.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'working.json'), 'utf8')).events).sort(), ['e1', 'e3']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', '.shown-s1.json'), 'utf8')).ids, ['e1', 'e3', 'e4']);

  assert.equal(run(), null);
  fs.appendFileSync(events, line('e5', 'item-message', ago(0), { key: 'w/A1', text: 'And bigger' }) + '\n');
  assert.match(run().additionalContext, /^The owner wrote[^\n]*\nsent \S+, just now: message received from A1's thread: reply in its thread\nevent data\/events\.jsonl \{"id":"e5"[^\n]*$/);

  // Once the watcher wakes past them, they drop out of the shown list.
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 6 });
  fs.appendFileSync(events, line('e6', 'item-message', ago(0), { key: 'w/A1', text: 'Last one' }) + '\n');
  assert.match(run().additionalContext, /"id":"e6"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', '.shown-s1.json'), 'utf8')).ids, ['e6']);

  // No watcher has run for the session yet: nothing to measure against, so nothing shows.
  fs.rmSync(path.join(dir, 'data', '.watch-cursor-s1.json'));
  fs.appendFileSync(events, line('e7', 'item-message', ago(0), { key: 'w/A1', text: 'Unseen' }) + '\n');
  assert.equal(run(), null);
  assert.equal(run({ hook_event_name: 'PreToolUse' }), null);
});

test('the plugin runs the hook after every tool call, through the skills link', () => {
  const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./hooks.json', import.meta.url)), 'utf8'));
  assert.deepEqual(plugin.hooks.PostToolUse, [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/skills/kickflip/hooks-plugin/hooks/board-messages.mjs"' }] }]);
});
