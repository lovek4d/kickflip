import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { merge3 } from './merge3.mjs';

test('merge3 keeps both sides changes to different cards, fields and additions', () => {
  const base = { title: 'W', items: [{ id: 'A', next: 'x' }, { id: 'B' }, { id: 'C' }] };
  const mine = { title: 'W', items: [{ id: 'A', next: 'x', status: 'done' }, { id: 'B' }, { id: 'C' }, { id: 'M' }] };
  const theirs = { title: 'W', items: [{ id: 'A', next: 'x' }, { id: 'B', size: 's' }, { id: 'T' }] };
  assert.deepEqual(merge3(base, mine, theirs), { title: 'W', items: [{ id: 'A', next: 'x', status: 'done' }, { id: 'B', size: 's' }, { id: 'T' }, { id: 'M' }] });
});

test('merge3 lets mine win a field both changed, and drops a card mine removed', () => {
  const base = { items: [{ id: 'A', n: 1 }, { id: 'B' }] };
  assert.deepEqual(merge3(base, { items: [{ id: 'A', n: 2 }] }, { items: [{ id: 'A', n: 3 }, { id: 'B' }] }), { items: [{ id: 'A', n: 2 }] });
});

test('many processes running item set on different cards lose none', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'board.mjs');
  const file = path.join(home, '.claude', 'waves', 'w', 'wave.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ids = Array.from({ length: 12 }, (_, n) => `C${n}`);
  fs.writeFileSync(file, JSON.stringify({ title: 'W', items: ids.map((id) => ({ id, title: id })) }));
  try {
    const codes = await Promise.all(ids.map((id) => new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, 'item', 'set', `w/${id}`, '--next', `next ${id}`], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' } });
      child.on('close', resolve);
    })));
    assert.deepEqual(codes, ids.map(() => 0));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((i) => i.next), ids.map((id) => `next ${id}`));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
