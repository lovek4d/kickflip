// docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: an ask is a T-<n> card from
// arrival, answered on the card into In Review for the owner's Done, merged into another card's thread, or dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, movesOf } from './domain.mjs';
import { board, home, site, read, write, lines } from './board-fixture.mjs';

const ask = { id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Fix the header\nIt jumps on scroll' } };
function built({ item = {}, events = [], threads = {}, askLinks = {}, working = {}, extra = [] } = {}) {
  return buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, askLinks, working,
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Fix the header', created: '2026-11-09T10:00:01Z', lane: 'todo', from_ask: 'a1', ...item }, ...extra] } }],
    prs: {}, owner: {}, events: [ask, ...events],
  });
}
const card = (b, key = 'hub/T-1') => b.items.find((i) => i.key === key);

test('a card an ask became reads New with its ask state until it is sorted, and the ask has no row of its own', () => {
  const b = built();
  const c = card(b);
  assert.deepEqual([c.lane, c.isNew, c.unsorted, c.ask.eventId, c.ask.state, c.ask.canEdit], ['todo', true, true, 'a1', 'waiting', true]);
  assert.equal(b.items.some((i) => i.kind === 'ask'), false);
  assert.equal(b.moved['ask:a1'], 'hub/T-1');
  // The intake wait is on the card, naming how to sort it.
  assert.equal(c.orchestrator.kind, 'intake');
  assert.match(c.orchestrator.next, /item set hub\/T-1 --phase/);
  assert.match(c.orchestrator.next, /reply hub\/T-1/);
  // Picked up, it reads working; sorted, it reads as a task.
  assert.equal(card(built({ working: { a1: '2026-11-09T10:01:00Z' } })).ask.state, 'working');
  const sorted = card(built({ item: { phase: 'grilling' } }));
  assert.deepEqual([Boolean(sorted.isNew), sorted.ask ?? null, sorted.unsorted], [false, null, false]);
});

test('an answered card waits in In Review for the owner\'s Done with no Action needed, a reply holds it on the orchestrator, and the answer shows in the banner', () => {
  const threads = { 'hub/T-1': [{ ts: '2026-11-09T10:05:00Z', who: 'claude', text: 'It jumps because of the sticky bar.' }] };
  const answered = built({ item: { answered_at: '2026-11-09T10:05:00Z' }, threads });
  const c = card(answered);
  assert.deepEqual([c.lane, c.waitsOn, c.awaitsDone, c.action, c.next, Boolean(c.isNew), c.answered], ['review', 'owner', true, null, 'Tap Done', false, true]);
  assert.deepEqual(answered.answers.map((a) => [a.key, a.at]), [['hub/T-1', '2026-11-09T10:05:00Z']]);
  // The settle pass moves it to In Review saying why.
  assert.deepEqual(movesOf(answered).map((m) => [m.key, m.to, m.why]), [['hub/T-1', 'review', 'answered, it waits for your Done']]);

  const reply = { id: 'm1', ts: '2026-11-09T10:10:00Z', kind: 'item-message', data: { key: 'hub/T-1', text: 'And on mobile?' } };
  const replied = card(built({ item: { answered_at: '2026-11-09T10:05:00Z', lane: 'review' }, threads, events: [reply] }));
  assert.deepEqual([replied.lane, replied.awaitsDone, replied.next], ['review', false, 'Your reply waits on the orchestrator']);

  const done = { id: 'd1', ts: '2026-11-09T10:20:00Z', kind: 'card-done', data: { key: 'hub/T-1' } };
  assert.equal(card(built({ item: { answered_at: '2026-11-09T10:05:00Z', lane: 'review', lane_at: '2026-11-09T10:06:00Z' }, threads, events: [done] })).lane, 'done');
});

test('a card merged into another has no row, its ask opens the other card, and the merge feeds the top banner until that card is read', () => {
  const threads = { 'ask:a1': [{ ts: '2026-11-09T10:07:00Z', who: 'claude', kind: 'hub', line: 'card-merged', text: 'Merged into T-2.', into: 'hub/T-2' }] };
  const b = buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, askLinks: { a1: 'hub/T-2' },
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-2', title: 'Header polish', lane: 'todo', phase: 'grilling' }] } }],
    prs: {}, owner: {}, events: [ask],
  });
  assert.equal(b.items.some((i) => i.kind === 'ask'), false);
  assert.equal(b.moved['ask:a1'], 'hub/T-2');
  assert.deepEqual(b.merges, [{ key: 'hub/T-2', ref: 'T-2', text: 'Fix the header', at: '2026-11-09T10:07:00Z' }]);
});

// The CLI and the board server's filing, on the audit board (data/items.json).
const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}

test('the board files a New ask as a T-<n> card once, titled by its first line with no phase, and never reuses a number a dropped card had', async () => {
  auditEvents(ask, { id: 'a2', ts: '2026-11-09T10:01:00Z', kind: 'ask', data: { text: '', files: [{ name: 'shot.png' }] } });
  const s = await store();
  assert.deepEqual(await s.fileAsk(audit(), 'a1'), 'audit/T-1');
  assert.equal(await s.fileAsk(audit(), 'a1'), null);
  const items = read(audit('data', 'items.json')).items;
  const t1 = items.find((i) => i.id === 'T-1');
  assert.deepEqual([t1.title, t1.from_ask, t1.phase, t1.lane], ['Fix the header', 'a1', undefined, 'todo']);
  // Withdrawn while New, the card goes with no Done row; the next task takes a new number.
  assert.equal(await s.dropAskCard(audit(), 'a1'), 'audit/T-1');
  assert.equal(read(audit('data', 'items.json')).items.some((i) => i.id === 'T-1'), false);
  assert.equal(await s.fileAsk(audit(), 'a2'), 'audit/T-2');
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-2').title, 'shot.png');
  // A sorted card is not dropped by a withdrawal.
  assert.equal(board('item', 'set', 'audit/T-2', '--phase', 'grilling', '--site', 'audit').code, 0);
  assert.equal(await s.dropAskCard(audit(), 'a2'), null);
});

test('reply on a New card answers it: a message in its thread and the answered mark; on a sorted card it is refused, and --phase takes an answered card back to Todo', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = board('reply', 'audit/T-1', '--text', 'It jumps because of the sticky bar.', '--title', 'Header jumps on scroll', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  const t1 = read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
  assert.deepEqual([Boolean(t1.answered_at), t1.title], [true, 'Header jumps on scroll']);
  assert.deepEqual(lines(audit('data', 'threads', 'audit__T-1.jsonl')).map((m) => m.text), ['It jumps because of the sticky bar.']);
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'grilling', '--site', 'audit').code, 0);
  const regrilled = read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
  assert.deepEqual([regrilled.answered_at, regrilled.phase, regrilled.lane], [undefined, 'grilling', 'todo']);
  assert.match(board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit').err, /sorted/);
  assert.match(board('reply', 'audit/A1', '--text', 'x', '--site', 'audit').err, /not a card an ask became/);
});

test('reply to an ask whose card is New writes the reply and marks the card answered', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  assert.equal(board('reply', 'a1', '--text', 'Yes.', '--site', 'audit').code, 0);
  assert.equal(Boolean(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').answered_at), true);
});

test('item relate-ask on an ask whose card is New merges it: the card goes, its thread lines move to the ask\'s thread, and a card-merged line names the card it went into', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  write(audit('data', 'threads', 'audit__T-1.jsonl'), JSON.stringify({ ts: '2026-11-09T10:02:00Z', who: 'love', text: 'Also the footer' }) + '\n');
  const r = board('item', 'relate-ask', 'a1', 'audit/A1', '--summary', 'Same as the header work', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.some((i) => i.id === 'T-1'), false);
  assert.equal(fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl')), false);
  const askThread = lines(audit('data', 'threads', 'ask__a1.jsonl'));
  assert.deepEqual(askThread.map((m) => m.text), ['Also the footer', 'Merged into A1.']);
  assert.deepEqual([askThread[1].line, askThread[1].into], ['card-merged', 'audit/A1']);
  assert.deepEqual(read(audit('data', 'ask-links.json')), { links: { a1: 'audit/A1' } });
  // A sorted card is filed work: relate-ask refuses rather than dropping it.
  auditEvents({ ...ask, id: 'a3' });
  await s.fileAsk(audit(), 'a3');
  board('item', 'set', 'audit/T-2', '--phase', 'grilling', '--site', 'audit');
  assert.match(board('item', 'relate-ask', 'a3', 'audit/A1', '--summary', 'x', '--site', 'audit').err, /became audit\/T-2/);
});

test('a Quick build ask\'s New card goes ready from new on item set --phase ready with its size and notes', async () => {
  auditEvents({ ...ask, data: { ...ask.data, quick: true } });
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'Pin the header.');
  assert.equal(board('item', 'notes', 'audit/T-1', '--heading', 'Scope', '--file', notes, '--site', 'audit').code, 0);
  const r = board('item', 'set', 'audit/T-1', '--phase', 'ready', '--size', 'small', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').phase, 'ready');
  // item add --from-ask on an ask that already has its card points at the card.
  assert.match(board('item', 'add', 'audit', '--from-ask', 'a1', '--text', 'x', '--title', 'X', '--phase', 'grilling', '--site', 'audit').err, /already card audit\/T-1/);
});
