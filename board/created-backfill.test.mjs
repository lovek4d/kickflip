// docs/adr/2026-11-16-1400-todo-sorts-strictly-by-created.md: Todo sorts strictly by created; old cards take their first event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { migrateCreated } from './migrations.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

function world(items) {
  const site = tempDir('created-');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items }));
  const read = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items;
  return { site, data, read };
}

test('the start-up backfill gives a card with no created its thread\'s first event, once', async () => {
  const w = world([{ id: 'A1', title: 'Held', lane: 'todo' }, { id: 'A2', title: 'Kept', lane: 'todo', created: '2026-11-02T00:00:00Z' }, { id: 'A3', title: 'No thread', lane: 'todo' }]);
  fs.writeFileSync(path.join(w.data, 'threads', 't__A1.jsonl'), ['2026-11-01T00:00:00Z', '2026-11-09T00:00:00Z'].map((ts) => JSON.stringify({ ts, who: 'claude', text: 'x' })).join('\n') + '\n');
  assert.deepEqual(await migrateCreated(w.site), ['t: 1 tasks took their first event as created']);
  assert.deepEqual(w.read().map((it) => it.created ?? null), ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', null]);
  assert.deepEqual(await migrateCreated(w.site), []);
});
