import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-board-')));
process.env.HOME = home;
const { requestBoard, dismissBoard } = await import('./new-board.mjs');
const { startingBoards, STARTING_WAIT } = await import('./sessions.mjs');
const { routeFromName, ROUTE_RE } = await import('./routes.mjs');
const { saveJSON, readManifest } = await import('./boards.mjs');
const manifestFile = path.join(home, '.claude', 'web-ts', 'manifest.json');
const dir = path.join(home, 'hub-board');
const board = { dir, port: 0, cmd: [process.execPath, fileURLToPath(new URL('../board/server.mjs', import.meta.url))] };
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('a new board reservation and its ask survive without a running board server', async () => {
  saveJSON(manifestFile, { sites: { 'hub-orchestrator': board } });
  assert.deepEqual(await requestBoard({ name: 'Backend audit', repo: '~', purpose: 'Review changes' }), { route: 'backend-audit' });
  const manifest = readManifest();
  const rec = manifest.starting['backend-audit'];
  const [event] = fs.readFileSync(path.join(dir, 'data/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(event.kind, 'ask');
  assert.deepEqual(event.data, { text: `New board: Backend audit in ${home} — Review changes`,
    newBoard: { route: 'backend-audit', title: 'Backend audit', repo: home, purpose: 'Review changes' } });
  const at = Date.parse(rec.asked_at);
  assert.equal(startingBoards(manifest, at + STARTING_WAIT - 1)[0].failed, false);
  assert.equal(startingBoards(manifest, at + STARTING_WAIT)[0].failed, true);
  const launched = { ...manifest, starting: { 'backend-audit': { ...rec, session: 's-new', since: new Date(at + 5000).toISOString() } } };
  assert.equal(startingBoards(launched, at + STARTING_WAIT)[0].failed, true);
  assert.deepEqual(startingBoards({ ...launched, sites: { ...launched.sites, 'backend-audit': board } }, at + STARTING_WAIT), []);
  await assert.rejects(dismissBoard('backend-audit'), { status: 400 });
  rec.asked_at = new Date(Date.now() - STARTING_WAIT).toISOString();
  saveJSON(manifestFile, manifest);
  assert.deepEqual(await dismissBoard('backend-audit'), { route: 'backend-audit' });
  assert.equal(readManifest().starting, undefined);
});

test('requests validate fields, home containment, route reservations and the hub before recording anything', async () => {
  const input = { name: 'New board', repo: home, purpose: '' };
  saveJSON(manifestFile, { sites: {} });
  await assert.rejects(requestBoard(input), { status: 503, message: 'No hub session' });
  const manifest = { sites: { 'hub-orchestrator': board, board }, starting: { pending: { since: new Date().toISOString() } } };
  saveJSON(manifestFile, manifest);
  fs.symlinkSync(path.dirname(home), path.join(home, 'outside'));
  for (const change of [{ extra: true }, { name: '' }, { name: 'n'.repeat(61) }, { name: '!!!' }, { name: 'Board' }, { name: 'Pending' },
    { repo: 'relative' }, { repo: path.dirname(home) }, { repo: '~/outside' }, { repo: '~/absent' }, { purpose: 'p'.repeat(241) }, { purpose: null }]) {
    await assert.rejects(requestBoard({ ...input, ...change }), { status: 400 });
  }
  assert.deepEqual(readManifest(), manifest);
  assert.equal(routeFromName('  Backend & Audit! '), 'backend-audit');
  assert.equal(routeFromName('N'.repeat(60)), 'n'.repeat(41));
  assert.equal(routeFromName('__proto__'), 'proto');
  assert.ok(ROUTE_RE.test(routeFromName('Backend audit')));
});
