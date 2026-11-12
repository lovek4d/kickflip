// docs/adr/2026-11-12-0700-reply-implement-marks-a-card-ready-to-implement.md: the orchestrator's `reply <card> --implement`
// marks a card ready to implement. The card reads Action needed in Todo, its thread's Implement goes orange, and the
// owner's Implement tap or any message of theirs clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard } from './domain.mjs';
import { board, home, site, read } from './board-fixture.mjs';

function built(item = {}) {
  return buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads: {}, working: {},
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Rethink the footer', created: '2026-11-09T10:00:01Z', lane: 'todo', phase: 'discussing', ...item }] } }],
    prs: {}, owner: {}, events: [],
  });
}
const card = (b) => b.items.find((i) => i.key === 'hub/T-1');

test('a card marked ready to implement reads Action needed in Todo, with the thread as its link, and counts as a need', () => {
  const c = card(built({ implement_ready: { at: '2026-11-09T11:00:00Z' } }));
  assert.deepEqual([c.lane, c.implementReady], ['todo', true]);
  assert.deepEqual(c.action, { kind: 'implement', url: '#selectedCard=hub%2FT-1&reply', label: 'Tap Implement' });
  assert.deepEqual(card(built()).action, null);
  assert.equal(card(built()).implementReady, false);
});

const audit = (...p) => site('audit', ...p);
const t1 = () => read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}
const ask = { id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Rethink the footer' } };

test('reply --implement posts the message and stores the mark; the owner\'s Implement tap or any message clears it; a reply without the flag sets none', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  assert.equal(board('reply', 'audit/T-1', '--text', 'Plain.', '--site', 'audit').code, 0);
  assert.equal(t1().implement_ready, undefined);
  const r = board('reply', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(t1().implement_ready.at, /^\d{4}-/);
  await s.clearImplementReady(audit(), 'audit/T-1');
  assert.equal(t1().implement_ready, undefined);
  board('reply', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  await s.stageImplement(audit(), 'audit/T-1', {});
  assert.equal(t1().implement_ready, undefined);
});

test('--implement is refused on a reply to an event, which has no card to mark', () => {
  const r = board('reply', 'e1', '--text', 'x', '--implement', '--site', 'audit');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--implement/);
});
