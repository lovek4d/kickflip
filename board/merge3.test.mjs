import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { merge3 } from './merge3.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

test('merge3 keeps both sides changes to different cards, fields and additions', () => {
  const base = { title: 'W', items: [{ id: 'A', next: 'x' }, { id: 'B' }, { id: 'C' }] };
  const mine = { title: 'W', items: [{ id: 'A', next: 'x', lane: 'done' }, { id: 'B' }, { id: 'C' }, { id: 'M' }] };
  const theirs = { title: 'W', items: [{ id: 'A', next: 'x' }, { id: 'B', size: 's' }, { id: 'T' }] };
  assert.deepEqual(merge3(base, mine, theirs), { title: 'W', items: [{ id: 'A', next: 'x', lane: 'done' }, { id: 'B', size: 's' }, { id: 'T' }, { id: 'M' }] });
});

test('merge3 lets mine win a field both changed, and drops a card mine removed', () => {
  const base = { items: [{ id: 'A', n: 1 }, { id: 'B' }] };
  assert.deepEqual(merge3(base, { items: [{ id: 'A', n: 2 }] }, { items: [{ id: 'A', n: 3 }, { id: 'B' }] }), { items: [{ id: 'A', n: 2 }] });
});

test('merge3 matches records with no id by key: waits, done archive cards', () => {
  const base = { waits: [{ key: 'a', next: 1 }, { key: 'b' }] };
  const mine = { waits: [{ key: 'a', next: 2 }, { key: 'b' }, { key: 'm' }] };
  const theirs = { waits: [{ key: 'a', next: 1 }, { key: 'b', bumped: true }, { key: 't' }] };
  assert.deepEqual(merge3(base, mine, theirs), { waits: [{ key: 'a', next: 2 }, { key: 'b', bumped: true }, { key: 't' }, { key: 'm' }] });
  const archive = { cards: [{ key: 'x', closed_at: 1 }] };
  assert.deepEqual(merge3(archive, { cards: [{ key: 'y' }, { key: 'x', closed_at: 1 }] }, { cards: [{ key: 'x', closed_at: 1 }, { key: 'z' }] }), { cards: [{ key: 'x', closed_at: 1 }, { key: 'z' }, { key: 'y' }] });
});

test('merge3 keeps last writer for a list whose keys repeat, as try groups of one card may', () => {
  const g = (pgid) => ({ pgid, key: 'main' });
  assert.deepEqual(merge3({ groups: [g(1)] }, { groups: [g(1), g(2)] }, { groups: [g(3)] }), { groups: [g(1), g(2)] });
});

// The processes contend for the item file's lock with no deadline: load decides how long each waits, not whether it
// fails.
test('many processes running item set on different cards lose none', async () => {
  const home = tempDir('board-');
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'board.mjs');
  const file = path.join(home, '.claude', 'waves', 'w', 'wave.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ids = Array.from({ length: 12 }, (_, n) => `C${n}`);
  fs.writeFileSync(file, JSON.stringify({ title: 'W', items: ids.map((id) => ({ id, title: id })) }));
  try {
    const codes = await Promise.all(ids.map((id) => new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, 'item', 'set', `w/${id}`, '--next', `next ${id}`], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1', KICKFLIP_LOCK_TIMEOUT_MS: 'Infinity' } });
      child.on('close', resolve);
    })));
    assert.deepEqual(codes, ids.map(() => 0));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((i) => i.next), ids.map((id) => `next ${id}`));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
