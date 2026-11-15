// docs/adr/2026-11-16-0200-boot-lists-replies-once-and-skips-done-cards-agent-files.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';
import { readReplyIndex, replyFilesOf, readAgents } from './store.mjs';

const tmp = () => tempDir('reply-index-');

test('readReplyIndex groups one listing by event id, oldest reply first, as replyFilesOf reads each', async () => {
  const dir = tmp();
  for (const n of ['a.md', 'a~2.md', 'a~3.json', 'b.html', 'b.md', 'x.y.md', 'note.txt', 'c~2.md']) fs.writeFileSync(path.join(dir, n), 'x');
  const index = await readReplyIndex(dir);
  assert.deepEqual([...index.keys()].sort(), ['a', 'b', 'c', 'x.y']);
  for (const id of ['a', 'b', 'c', 'x.y', 'none']) assert.deepEqual(index.get(id) || [], await replyFilesOf(dir, id), id);
  assert.deepEqual(index.get('a').map((f) => f.name), ['a.md', 'a~2.md', 'a~3.json']);
  assert.deepEqual(index.get('b').map((f) => f.name), ['b.md']);
});

test('readReplyIndex of a missing folder is empty', async () => {
  assert.equal((await readReplyIndex(path.join(tmp(), 'nope'))).size, 0);
});

test('readAgents skips the files of the ids it is told to skip', async () => {
  const dir = tmp();
  for (const f of ['T-1.json', 'T-1@helper.json', 'T-2.json']) fs.writeFileSync(path.join(dir, f), JSON.stringify({ label: f }));
  assert.deepEqual(Object.keys(await readAgents(dir)).sort(), ['T-1', 'T-2']);
  const live = await readAgents(dir, new Set(['T-1']));
  assert.deepEqual(Object.keys(live), ['T-2']);
  assert.equal(live['T-2'].main.label, 'T-2.json');
});
