import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent as hubAppendEvent } from '../hub/boards.mjs';
import { appendEvent, appendEvents, editJSON, readJSON, tellOnWrite, writeJSON } from './files.mjs';
import { restartLander } from './runs.mjs';

// docs/adr/2026-11-17-0521-every-process-writes-site-data-through-one-files-module.md
const siteOf = (route) => {
  const site = path.join(home, '.claude', 'kickflip', 'sites', route);
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: route, items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify({ items: [{ id: 'a', title: 'feat(board): seed', lane: 'todo' }] }));
  return site;
};
const tmpLeft = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
// e, the time in base 36, then five random base-36 characters.
const EVENT_ID = /^e[0-9a-z]{13}$/;

test('editJSON holds the file lock from read to rename, so concurrent edits all survive', async () => {
  const file = path.join(siteOf('edit'), 'data', 'landers.json');
  await Promise.all(Array.from({ length: 10 }, (_, i) => editJSON(file, (current) => { current[`t/${i}`] = { pid: i }; })));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 10);
  assert.deepEqual(tmpLeft(path.dirname(file)), []);
});

test('each write renames a tmp file of its own, so concurrent writes of one file in one process never share one', async () => {
  const file = path.join(siteOf('tmp'), 'data', 'idle.json');
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJSON(file, { n: i })));
  assert.equal(typeof JSON.parse(fs.readFileSync(file, 'utf8')).n, 'number');
  assert.deepEqual(tmpLeft(path.dirname(file)), []);
});

test('a write from a value read earlier merges, under the lock, with what was written since', async () => {
  const file = path.join(siteOf('merge'), 'data', 'headless-builders.json');
  fs.writeFileSync(file, JSON.stringify({ 't/a': { pid: 1 } }));
  const tracked = await readJSON(file, {});
  await editJSON(file, (current) => { current['t/b'] = { pid: 2 }; });
  await writeJSON(file, { 't/a': { pid: 3 } }, { from: tracked });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 't/a': { pid: 3 }, 't/b': { pid: 2 } });
});

test('every event append has one id scheme and tells the board it was written, before it returns', async () => {
  const site = siteOf('events');
  const told = [];
  const untell = tellOnWrite(site, (file) => told.push(file));
  try {
    const id = await appendEvent(site, 'ping', { title: 'x' });
    assert.match(id, EVENT_ID);
    assert.deepEqual(told, [path.join(site, 'data', 'events.jsonl')], 'told by the time the append returns');
    const ids = await appendEvents(site, [['a', {}], ['b', {}, 'e-preset']], new Date('2026-11-17T12:00:00Z'));
    assert.equal(ids[1], 'e-preset');
    assert.match(ids[0], EVENT_ID);
    // The hub's append to a board with no port is the same append.
    const hubId = await hubAppendEvent({ route: 'events', dir: site }, 'rules', { scope: 'hub' });
    assert.match(hubId, EVENT_ID);
    assert.equal(told.length, 3);
    const lines = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((e) => e.kind), ['ping', 'a', 'b', 'rules']);
    assert.equal(lines[1].ts, '2026-11-17T12:00:00.000Z');
  } finally { untell(); }
});

test('restartLander drops its card from landers.json under the lock, keeping an entry written meanwhile', async () => {
  const site = siteOf('landers');
  const file = path.join(site, 'data', 'landers.json');
  fs.writeFileSync(file, JSON.stringify({ 't/a': { verified: 'v1', pid: null } }));
  await Promise.all([
    restartLander(site, 't/a'),
    editJSON(file, (current) => { current['t/b'] = { verified: 'v2', pid: null }; }),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 't/b': { verified: 'v2', pid: null } });
});
