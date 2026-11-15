import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from '../shared/temp-dir.mjs';

process.env.HOME = fs.realpathSync(tempDir('auto-restarts-'));
const { logRestart, readRestarts, restartLines, restartHeld, autoRestartsFile, ROW_FOR } = await import('./auto-restarts.mjs');
const { hubView } = await import('./views.mjs');

test("each automatic restart is one line of the hub's log, and a board's Hub row says its newest one for a day", () => {
  const t0 = Date.parse('2026-11-15T12:00:00Z');
  const at = (min) => new Date(t0 + min * 60_000);
  logRestart({ board: 'shop', what: 'server', why: 'not answering', outcome: 'restarted' }, { now: at(0) });
  logRestart({ board: 'shop', what: 'server', why: 'not answering', outcome: 'back' }, { now: at(0.5) });
  logRestart({ board: 'orch', what: 'session', why: 'not listening', outcome: 'restarted' }, { now: at(3) });
  logRestart({ board: 'orch', what: 'session', why: 'not listening', outcome: 'failed', error: 'claude stop failed' }, { now: at(4) });
  fs.appendFileSync(autoRestartsFile(), '{"cut short');
  assert.deepEqual(readRestarts().map((e) => [e.at, e.board, e.what, e.why, e.outcome, e.error]), [
    [at(0).toISOString(), 'shop', 'server', 'not answering', 'restarted', undefined],
    [at(0.5).toISOString(), 'shop', 'server', 'not answering', 'back', undefined],
    [at(3).toISOString(), 'orch', 'session', 'not listening', 'restarted', undefined],
    [at(4).toISOString(), 'orch', 'session', 'not listening', 'failed', 'claude stop failed'],
  ]);
  assert.deepEqual([...restartLines(t0 + 5 * 60_000)], [
    ['shop', { link: 'restarted', detail: 'the server 5m ago: not answering' }],
    ['orch', { link: 'restarted', detail: 'the session 2m ago: not listening' }],
  ]);
  assert.equal(restartLines(t0 + 3 * 60_000 + 30_000).get('orch').detail, 'the session just now: not listening');
  assert.equal(restartLines(t0 + 3 * 3600_000).get('shop').detail, 'the server 3h ago: not answering');
  assert.deepEqual([...restartLines(t0 + 3 * 60_000 + ROW_FOR + 1).keys()], [], 'a day on, the row drops it');

  const sidebar = { sites: [{ route: 'orch', board: true }], hub: { tone: 'ok', word: 'healthy', detail: '' }, usage: {}, pause: {}, notifications: { text: 'On' } };
  const st = { settings: { notifications: { on: true } }, hold: null };
  const rows = [{ route: 'orch', title: 'Orch', state: 'up', restart: true }];
  const view = hubView({ now: new Date(t0 + 5 * 60_000), st, sidebar, rows, restarts: restartLines(t0 + 5 * 60_000) });
  assert.deepEqual(view.groups[0].sites[0].lines, [{ link: 'restarted', detail: 'the session 2m ago: not listening' }]);
});

test('an automatic restart waits while its session is busy, a builder of the board is open, or a land is queued or landing', async () => {
  const none = { builders: async () => [], lands: () => [] };
  assert.equal(await restartHeld({ dir: '/b', record: { status: 'idle' }, ...none }), null);
  assert.equal(await restartHeld({ dir: '/b', record: null, ...none }), null);
  assert.equal(await restartHeld({ dir: '/b', record: { status: 'busy' }, ...none }), 'its session is busy');
  assert.equal(await restartHeld({ dir: '/b', builders: async (dir) => (dir === '/b' ? [{ key: 'a/1' }] : []), lands: () => [] }), 'a builder is open');
  assert.equal(await restartHeld({ dir: '/b', builders: async () => [], lands: () => [{ card: 'x', running: true }] }), 'a land is queued or landing');
});
