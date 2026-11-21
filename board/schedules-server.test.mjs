import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBoard } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-21-2300-a-schedule-files-a-quick-build-on-a-cadence.md
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const asks = (dataDir) => (fs.existsSync(path.join(dataDir, 'events.jsonl')) ? fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'ask') : []);

test('the board minute fires a due schedule, holds it while the board is paused, and Board Settings edits and removes it', async (t) => {
  const siteDir = fs.mkdtempSync(path.join(home, 'schedules-'));
  const dataDir = path.join(siteDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  const boardFile = path.join(siteDir, 'board.json');
  const due = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(boardFile, JSON.stringify({ items: 'data/items.json', slug: 't', paused_until: 'forever', schedules: [{ id: 'news', text: 'Summarise the news', cadence: 'every 4h', due_at: due }] }));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [] }));
  const b = await startBoard(t, { site: siteDir });
  const minute = async () => { b.minute(); await b.settled(); };

  // Paused: the fire waits, its due time kept, so it comes once the pause lifts.
  await minute();
  assert.deepEqual([asks(dataDir).length, read(boardFile).schedules[0].due_at], [0, due]);
  const { paused_until: _, ...unpaused } = read(boardFile);
  fs.writeFileSync(boardFile, JSON.stringify(unpaused));
  await minute();
  const [ask] = asks(dataDir);
  assert.deepEqual([ask.data.text, ask.data.quick, ask.data.asked], ['Summarise the news', true, { by: 'schedule', schedule: 'news' }]);
  const card = read(path.join(dataDir, 'items.json')).items.find((it) => it.from_ask === ask.id);
  assert.equal(read(boardFile).schedules[0].last, `t/${card.id}`);

  const api = async (body) => {
    const r = await fetch(`${b.base}/api/schedules`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, body: await r.json() };
  };
  let r = await api();
  assert.deepEqual(r.body.schedules.map((s) => [s.id, s.last, s.last_ref]), [['news', `t/${card.id}`, card.id]]);
  r = await api({ id: 'news', text: 'Summarise the tech news', cadence: 'at 09:00 weekdays' });
  assert.deepEqual([r.status, r.body.schedules[0].text, r.body.schedules[0].cadence, r.body.schedules[0].last], [200, 'Summarise the tech news', 'at 09:00 weekdays', `t/${card.id}`]);
  r = await api({ id: 'news', cadence: 'every 1m' });
  assert.deepEqual([r.status, r.body.error], [400, 'a schedule runs at most every 15m']);
  r = await api({ id: 'news', remove: true });
  assert.deepEqual([r.status, r.body.schedules, read(boardFile).schedules], [200, [], undefined]);
});
