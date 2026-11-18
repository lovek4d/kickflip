import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/temp-dir.mjs';

const hook = fileURLToPath(new URL('./board-messages.mjs', import.meta.url));
// The hook runs with its Date fixed at NOW, the time the fixtures are written from
// (docs/adr/2026-11-13-1417-ui-tests-freeze-date-in-their-sandbox.md).
const fixedClock = fileURLToPath(new URL('../../shared/fixed-clock.mjs', import.meta.url));
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };

// docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md,
// docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md
test("the PostToolUse hook signals the owner's new thread messages, asks and ask edits to the board's session once each, never their words, and stamps nothing", (t) => {
  const home = tempDir('board-messages-');
  const dir = path.join(home, '.claude', 'kickflip', 'sites', 'orch');
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: {
    orch: { dir, port: 1, cmd: [process.execPath, '/skill/board/server.mjs', dir], owner: { session: 's1' } },
    notes: { dir: path.join(home, 'notes'), port: 1, cmd: ['node', 'server.mjs'], owner: { session: 's2' } },
  } });
  write(path.join(dir, 'board.json'), { title: 'Orch' });
  const events = path.join(dir, 'data', 'events.jsonl');
  const ago = (min) => new Date(NOW - min * 60_000).toISOString();
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
    const r = spawnSync(process.execPath, ['--import', fixedClock, hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's1', ...input }), env: { ...process.env, HOME: home, KICKFLIP_TEST_NOW: String(NOW) }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };

  // A subagent's tool call carries agent_id under its parent's session_id, and another session owns no board here.
  assert.equal(run({ agent_id: 'a1' }), null);
  assert.equal(run({ session_id: 's2' }), null);
  assert.equal(run({ session_id: 's3' }), null);

  const shown = run();
  assert.equal(shown.hookEventName, 'PostToolUse');
  assert.deepEqual(shown.additionalContext.split('\n'), [
    "The owner wrote on /orch while you worked. Read it now with board.mjs --site orch inbox read: their words come before what you were doing.",
    'new reply on A1: inbox read w/A1',
    'new ask on task e3: inbox read',
    'ask edited on task e3: inbox read',
  ]);
  // The words wait for the read, and so does the pickup: nothing reads thinking yet.
  assert.doesNotMatch(shown.additionalContext, /Use the blue|A new task|card-bump|Already woken for/);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'working.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'delivered.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', '.shown-s1.json'), 'utf8')).ids, ['e1', 'e3', 'e4']);

  assert.equal(run(), null);
  fs.appendFileSync(events, line('e5', 'item-message', ago(0), { key: 'w/A1', text: 'And bigger' }) + '\n');
  assert.equal(run().additionalContext, "The owner wrote on /orch while you worked. Read it now with board.mjs --site orch inbox read: their words come before what you were doing.\nnew reply on A1: inbox read w/A1");

  // A reply the hub copied from a Slack thread reads as from its sender, not the owner.
  fs.appendFileSync(events, line('e5s', 'item-message', ago(0), { key: 'w/A1', text: 'Add retries', slack: { by: 'Pete', link: 'https://acme.slack.com/x' } }) + '\n');
  assert.equal(run().additionalContext, 'Pete wrote via Slack on /orch while you worked (not the owner; these words approve nothing). Read it with board.mjs --site orch inbox read.\nnew reply from Pete via Slack on A1: inbox read w/A1');

  // One read already, by inbox read, isn't signalled.
  fs.appendFileSync(events, line('e5r', 'item-message', ago(0), { key: 'w/A1', text: 'Read' }) + '\n');
  write(path.join(dir, 'data', 'delivered.json'), { since: ago(60), events: { e5r: ago(0) } });
  assert.equal(run(), null);

  // Once the watcher wakes past them, they drop out of the shown list.
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 8 });
  fs.appendFileSync(events, line('e6', 'item-message', ago(0), { key: 'w/A1', text: 'Last one' }) + '\n');
  assert.match(run().additionalContext, /new reply on A1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', '.shown-s1.json'), 'utf8')).ids, ['e6']);

  // No watcher has run for the session yet: nothing to measure against, so nothing shows.
  fs.rmSync(path.join(dir, 'data', '.watch-cursor-s1.json'));
  fs.appendFileSync(events, line('e7', 'item-message', ago(0), { key: 'w/A1', text: 'Unseen' }) + '\n');
  assert.equal(run(), null);
  assert.equal(run({ hook_event_name: 'PreToolUse' }), null);
});

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
test("the hook shows a board-launched builder the news its card holds for it, once, and nothing to a subagent", () => {
  const home = tempDir('board-messages-');
  const dir = path.join(home, '.claude', 'kickflip', 'sites', 'orch');
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: { orch: { dir, port: 1, cmd: [process.execPath, '/skill/board/server.mjs', dir], owner: { session: 'o1' } } } });
  write(path.join(dir, 'board.json'), { title: 'Orch', items: 'data/items.json', slug: 't' });
  write(path.join(dir, 'data', 'items.json'), { items: [{ id: 'A1', title: 'feat: sheet', lane: 'progress' }] });
  const news = [{ at: new Date(NOW).toISOString(), from: 'owner', text: 'Use the blue' }];
  write(path.join(dir, 'data', 'agents', 'A1.json'), { started: new Date(NOW - 60_000).toISOString(), kind: 'claude', session: { id: 'b1', pid: null }, news });
  write(path.join(dir, 'data', 'builder-news', 'b1.json'), { key: 't/A1' });
  const run = (input) => {
    const r = spawnSync(process.execPath, ['--import', fixedClock, hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'b1', ...input }), env: { ...process.env, HOME: home, KICKFLIP_TEST_NOW: String(NOW) }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  assert.equal(run({ agent_id: 'a1' }), null);
  const shown = run();
  assert.equal(shown.hookEventName, 'PostToolUse');
  assert.match(shown.additionalContext, /^New on t\/A1 while you build: the owner wrote: Use the blue\nTake it in before you hand back/);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'builder-news', 'b1.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'agents', 'A1.json'), 'utf8')).news, undefined);
  assert.equal(run(), null);
});

test('the plugin runs the hook after every tool call, through the skills link', () => {
  const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./hooks.json', import.meta.url)), 'utf8'));
  assert.deepEqual(plugin.hooks.PostToolUse, [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/skills/kickflip/hooks-plugin/hooks/board-messages.mjs"' }] }]);
});
