import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitSharedNotes } from './store.mjs';

// docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md
function world() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'card-notes-'));
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'shared.md'), '# Shared\n');
  fs.writeFileSync(path.join(data, 'old.md'), '# Old\n');
  fs.writeFileSync(path.join(data, 'own.md'), '# Own\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'A1', title: 'First', created: '2026-11-01T00:00:00Z', plan: 'shared.md' },
    { id: 'A2', title: 'Second', created: '2026-11-02T00:00:00Z', plan: './shared.md' },
    { id: 'A3', title: 'Later', created: '2026-11-03T00:00:00Z', plan: 'old.md' },
    { id: 'A4', title: 'Alone', created: '2026-11-04T00:00:00Z', plan: 'own.md' },
  ] }));
  fs.writeFileSync(path.join(data, 'done-archive.json'), JSON.stringify({ cards: [
    { key: 't/Z9', wave: 't', closed_at: '2026-10-20T00:00:00Z', item: { id: 'Z9', title: 'Archived', created: '2026-10-01T00:00:00Z', lane: 'done', plan: 'old.md' } },
  ] }));
  const items = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items;
  const thread = (id) => fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).text);
  return { site, data, items, thread };
}

test("at start-up a card sharing a notes file with an earlier card, live or archived, gets its own copy, and every card's notes are read-only", async () => {
  const w = world();
  const lines = await splitSharedNotes(w.site);
  assert.deepEqual(lines, ['t/A2: its own notes, a2-notes.md, copied from shared.md, which t/A1 keeps', 't/A3: its own notes, a3-notes.md, copied from old.md, which t/Z9 keeps']);
  assert.deepEqual(w.items().map((it) => it.plan), ['shared.md', 'a2-notes.md', 'a3-notes.md', 'own.md']);
  assert.equal(fs.readFileSync(path.join(w.data, 'a2-notes.md'), 'utf8'), '# Shared\n');
  assert.equal(fs.readFileSync(path.join(w.data, 'a3-notes.md'), 'utf8'), '# Old\n');
  assert.deepEqual(w.thread('A2'), ['It shared its notes file with A1, so the board gave it its own copy.']);
  for (const f of ['shared.md', 'a2-notes.md', 'a3-notes.md', 'own.md', 'old.md']) assert.equal(fs.statSync(path.join(w.data, f)).mode & 0o222, 0, f);
  assert.deepEqual(await splitSharedNotes(w.site), []);
  fs.rmSync(w.site, { recursive: true, force: true });
});
