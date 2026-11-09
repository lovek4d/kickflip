// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md: a bump lasts until its unbump or the card's
// close, which the land queue reads too. A bump past the cap pausing a build is card-pause.test.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { home, at, site, write, read } from './board-fixture.mjs';
import * as store from './store.mjs';

const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const addEvent = (kind, ts, data) => write(site('orch', 'data', 'events.jsonl'), [...readEvents(), { id: `${kind}-${ts}`, ts, kind, data }].map((e) => JSON.stringify(e)).join('\n') + '\n');
function onHome(t) {
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = old; });
}
function readEvents() {
  try { return fs.readFileSync(site('orch', 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

test('the land queue takes a bump made before the first build, and drops one made before the card last closed', async (t) => {
  onHome(t);
  setA1({ lane: 'progress' });
  write(recordFile(), { started: '2026-11-06T10:00:00.000Z', kind: 'claude' });
  addEvent('card-bump', '2026-11-06T09:00:00.000Z', { key: 'w/A1' });
  assert.equal(await store.landFirst(site('orch'), 'w/A1'), '2026-11-06T09:00:00.000Z');
  setA1({ lane: 'progress', closed_at: '2026-11-06T09:30:00.000Z', reopened_at: '2026-11-06T09:40:00.000Z' });
  assert.equal(await store.landFirst(site('orch'), 'w/A1'), null);
  addEvent('card-unbump', '2026-11-06T09:50:00.000Z', { key: 'w/A1' });
  addEvent('card-bump', '2026-11-06T09:55:00.000Z', { key: 'w/A1' });
  assert.equal(await store.landFirst(site('orch'), 'w/A1'), '2026-11-06T09:55:00.000Z');
});
