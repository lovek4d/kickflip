// docs/adr/2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire.md: every ask with no card of its
// own becomes a T-<n> card in asked order, an answered one closed in Done at its answer time, and the ask-only records go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBoard } from './domain.mjs';
import { at, board, home, site, read, write } from './board-fixture.mjs';

const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const ask = (id, ts, text, extra = {}) => ({ id, ts, kind: 'ask', data: { text, ...extra } });
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}
const items = () => read(audit('data', 'items.json')).items;
const card = (from) => items().find((i) => i.from_ask === from);

test('fileAsks makes each ask with no card a T-<n> card in asked order: answered ones closed in Done at their answer time, a New one New, and nothing for a deleted, folded, moved or filed ask', async () => {
  auditEvents(
    ask('a1', '2026-11-01T10:00:00Z', 'Why is the header slow?\nDetails'),
    ask('a2', '2026-11-01T11:00:00Z', 'Ping'),
    ask('a3', '2026-11-01T12:00:00Z', 'Add a footer'),
    ask('a4', '2026-11-01T13:00:00Z', 'Never mind'),
    { id: 'w4', ts: '2026-11-01T13:01:00Z', kind: 'ask-withdrawn', data: { id: 'a4' } },
    ask('a5', '2026-11-01T14:00:00Z', 'Folded'),
    ask('a6', '2026-11-01T15:00:00Z', 'Moved'),
    ask('a7', '2026-11-01T16:00:00Z', 'Filed'),
    ask('a8', '2026-11-01T09:00:00Z', 'Titled by triage'),
    { id: 'd8', ts: '2026-11-01T09:30:00Z', kind: 'ask-done', data: { id: 'a8' } },
    // Deleted from its New card, which sends the card's key and drops the card.
    ask('a9', '2026-11-01T17:00:00Z', 'Deleted from its card'),
    { id: 'w9', ts: '2026-11-01T17:01:00Z', kind: 'ask-withdrawn', data: { id: 'a9', key: 'audit/T-9' } },
  );
  write(audit('data', 'items.json'), { items: [{ id: 'A1', title: 'One' }, { id: 'T-1', title: 'Filed', lane: 'todo', phase: 'grilling', from_ask: 'a7' }] });
  write(audit('data', 'replies', 'a1.md'), 'Because of the font.');
  const replied = new Date('2026-11-01T10:30:00Z');
  fs.utimesSync(audit('data', 'replies', 'a1.md'), replied, replied);
  write(audit('data', 'threads', 'ask__a8.jsonl'), JSON.stringify({ ts: '2026-11-01T09:20:00Z', who: 'claude', text: 'Done.' }) + '\n');
  write(audit('data', 'threads', 'ask__a6.jsonl'), JSON.stringify({ ts: '2026-11-01T15:05:00Z', who: 'claude', kind: 'hub', line: 'ask-moved', text: 'Moved to Other.' }) + '\n');
  write(audit('data', 'ask-links.json'), { links: { a5: 'audit/A1' } });
  write(audit('data', 'ask-progress.json'), { asks: { a2: { state: 'done', at: '2026-11-01T11:10:00Z' }, a8: { state: 'done', at: '2026-11-01T09:25:00Z' } } });
  write(audit('data', 'ask-titles.json'), { titles: { a8: 'Triage title' } });
  write(audit('data', 'owner.json'), { topics: [], items: [{ id: 'q1', topic: 'item:ask:a1', question: 'Which font?', options: [{ id: 'A', label: 'Inter' }], resolved: 'A', resolved_at: '2026-11-01T10:20:00Z' }] });

  const s = await store();
  assert.deepEqual(await s.fileAsks(audit()), ['audit/T-2', 'audit/T-3', 'audit/T-4', 'audit/T-5']);
  // Asked order: a8 (09:00), a1, a2, a3.
  assert.deepEqual(['a8', 'a1', 'a2', 'a3'].map((id) => card(id).id), ['T-2', 'T-3', 'T-4', 'T-5']);
  const pick = (i) => [i.title, i.lane, i.closed_at, i.phase, i.created];
  assert.deepEqual(pick(card('a8')), ['Triage title', 'done', '2026-11-01T09:20:00Z', 'closed', '2026-11-01T09:00:00Z']);
  assert.deepEqual(pick(card('a1')), ['Why is the header slow?', 'done', '2026-11-01T10:30:00.000Z', 'closed', '2026-11-01T10:00:00Z']);
  // Closed by Claude's done mark alone, at that mark.
  assert.deepEqual(pick(card('a2')), ['Ping', 'done', '2026-11-01T11:10:00Z', 'closed', '2026-11-01T11:00:00Z']);
  const fresh = card('a3');
  assert.deepEqual([fresh.title, fresh.lane, fresh.closed_at, fresh.phase], ['Add a footer', 'todo', undefined, undefined]);
  for (const id of ['a4', 'a5', 'a6', 'a9']) assert.equal(card(id), undefined, id);
  // The ask's resolved question moves to its card's topic, and the ask-only records go.
  assert.equal(read(audit('data', 'owner.json')).items[0].topic, 'item:audit/T-3');
  assert.equal(fs.existsSync(audit('data', 'ask-progress.json')), false);
  assert.equal(fs.existsSync(audit('data', 'ask-titles.json')), false);
  // Once is enough: a second run files nothing.
  assert.deepEqual(await s.fileAsks(audit()), []);
  assert.equal(items().length, 6);
});

test('an ask with no card is listed as unfiled with no row of its own, and a moved or deleted ask is neither', async () => {
  const b = buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), askLinks: {},
    threads: { 'ask:a2': [{ ts: '2026-11-01T15:05:00Z', who: 'claude', kind: 'hub', line: 'ask-moved', text: 'Moved to Other.' }] },
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [] } }], prs: {}, owner: {},
    events: [ask('a1', '2026-11-09T10:00:00Z', 'Hi'), ask('a2', '2026-11-09T10:01:00Z', 'Elsewhere'), ask('a3', '2026-11-09T10:02:00Z', 'Gone'),
      { id: 'w3', ts: '2026-11-09T10:03:00Z', kind: 'ask-withdrawn', data: { id: 'a3', key: 'hub/T-1' } }],
  });
  assert.deepEqual(b.items, []);
  assert.deepEqual(b.unfiled, ['a1']);
});

test('ask progress and ask done are gone, and a question on an ask goes on its card', async () => {
  auditEvents(ask('a1', '2026-11-01T10:00:00Z', 'Hi'));
  const s = await store();
  await s.fileAsks(audit());
  assert.notEqual((await board('ask', 'done', 'a1', '--site', 'audit')).code, 0);
  assert.notEqual((await board('ask', 'progress', 'a1', '--site', 'audit')).code, 0);
  const q = { id: 'q1', topic: 'item:ask:a1', question: 'Which?', options: [{ id: 'A', label: 'This', recommended: true }, { id: 'B', label: 'That' }] };
  write(at('q.json'), [q]);
  const r = await board('question', 'add', '--site', 'audit', '--file', at('q.json'));
  assert.match(r.err, /item:audit\/T-1/);
});

test('an ask on a waves board with no wave yet is refused, since there is nowhere to file its card', async () => {
  fs.rmSync(at('waves'), { recursive: true, force: true });
  const s = await store();
  await assert.rejects(s.fileAsk(site('orch'), 'e9', { id: 'e9', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Hi' } }), /no wave/);
});
